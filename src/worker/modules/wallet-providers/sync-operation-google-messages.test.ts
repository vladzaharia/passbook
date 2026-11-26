// GM2: the Google change-message send path on the mock wallet server (google-messages.md section 11, worker tests 1-9, 13, 15).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSettingsCache } from '../settings/service.ts';
import { messageKit } from './google-messages-test-fixtures.ts';

let restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.reverse()) undo();
  restore = [];
  vi.unstubAllGlobals();
});

/** Lets the real mock answer, then drops the response: the request left and its outcome is unknown. */
function loseResponse(match: RegExp) {
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await real(input, init);
    if (match.test(`${init?.method} ${new URL(String(input)).pathname}`))
      throw new TypeError('connection lost');
    return response;
  });
  return () => vi.stubGlobal('fetch', real);
}

describe('a notifying edit', () => {
  it('PATCHes the object with its history, then sends one TEXT_AND_NOTIFY message', async () => {
    const t = await messageKit(restore);
    const mark = t.mock.requests.length;
    await t.edit('Updated Member');
    expect(t.calls(mark)).toEqual(['PATCH genericObject', 'POST genericObject/addMessage']);
    expect(t.patchedMessages(mark)).toEqual([]);
    expect(t.messages()).toMatchObject([
      { messageType: 'TEXT_AND_NOTIFY', body: 'Member is now Updated Member' },
    ]);
    expect(await t.ledger()).toMatchObject([{ state: 'notified', reason: null, tries: 1 }]);
    const events = await t.events();
    expect(events.map((e) => JSON.parse(e.data))).toMatchObject([
      { provider: 'google', outcome: 'notified' },
    ]);
    const outcomes = await t.db
      .prepare("SELECT 1 FROM wallet_provider_instance_outcomes WHERE stage = 'google-message'")
      .all();
    expect(outcomes.results).toHaveLength(1);
    expect(
      await t.first(
        t.db,
        "SELECT state FROM wallet_provider_instance_operations WHERE state != 'succeeded' AND kind = 'upsert'",
      ),
    ).toBeNull();
  });

  it('a broadcast message is the body', async () => {
    const t = await messageKit(restore);
    await t.broadcast('Gold', 'Gate moved to B');
    expect(t.messages()).toMatchObject([
      { body: 'Gate moved to B', messageType: 'TEXT_AND_NOTIFY' },
    ]);
  });
});

describe('the daily budget', () => {
  it('sends the fourth notifying change as TEXT without asking Google to notify', async () => {
    const t = await messageKit(restore);
    for (const name of ['One', 'Two', 'Three', 'Four']) {
      await t.edit(name);
      t.kit.clock.advance(60_000);
    }
    expect(t.sent()).toEqual(['TEXT_AND_NOTIFY', 'TEXT_AND_NOTIFY', 'TEXT_AND_NOTIFY', 'TEXT']);
    expect((await t.ledger()).map((r) => `${r.state}/${r.reason}`)).toEqual([
      'notified/null',
      'notified/null',
      'notified/null',
      'text/budget',
    ]);
  });

  it('resends a refused notification as TEXT, then stays TEXT for 24 hours', async () => {
    const t = await messageKit(restore);
    t.mock.seedNotifications('genericObject', String(t.object()?.id), 3);
    await t.edit('One');
    expect(t.sent()).toEqual(['TEXT_AND_NOTIFY', 'TEXT']);
    expect(await t.ledger()).toMatchObject([{ state: 'text', reason: 'quota' }]);
    expect(JSON.parse((await t.events())[0]?.data ?? '{}')).toMatchObject({
      outcome: 'text',
      reason: 'quota',
    });
    t.kit.clock.advance(60_000);
    await t.edit('Two');
    expect(t.sent()).toEqual(['TEXT_AND_NOTIFY', 'TEXT', 'TEXT']);
  });
});

describe('a message whose transport is unknown', () => {
  it('asks Google once: a message that arrived is notified, one that did not is unknown, and none is sent twice', async () => {
    const t = await messageKit(restore);
    const undo = loseResponse(/^POST .*\/addMessage$/);
    await t.edit('One');
    undo();
    expect(await t.ledger()).toMatchObject([{ state: 'notified' }]);
    expect(t.sent()).toHaveLength(1);
    t.kit.clock.advance(60_000);
    t.mock.failNext({ status: 503, match: 'POST .*/addMessage' });
    await t.edit('Two');
    expect(await t.ledger()).toMatchObject([
      { state: 'notified' },
      { state: 'unknown', reason: 'unconfirmed' },
    ]);
    expect(t.sent()).toHaveLength(2);
    expect(await t.events()).toHaveLength(2);
    expect(
      await t.first<{ n: number }>(
        t.db,
        "SELECT COUNT(*) AS n FROM wallet_provider_instance_operations WHERE kind = 'upsert' AND state = 'succeeded'",
      ),
    ).toMatchObject({ n: 3 });
  });

  it('a row left sending is read before the next write, kept in the history and not sent again', async () => {
    const t = await messageKit(restore);
    const undo = loseResponse(/^POST .*\/addMessage$/);
    t.mock.failNext({ status: 500, match: 'GET /walletobjects/v1/genericObject' });
    await t.edit('One');
    undo();
    expect(await t.ledger()).toMatchObject([{ state: 'sending' }]);
    t.kit.clock.advance(60_000);
    const mark = t.mock.requests.length;
    await t.edit('Two');
    expect(t.calls(mark)).toEqual([
      'GET genericObject',
      'PATCH genericObject',
      'POST genericObject/addMessage',
      // An upsert operation touches the class, so it refreshes Google's review of it after the write, off the run (waitUntil):
      // one read per backoff window, and never once the class is APPROVED. The mock class is not, and the window has passed.
      'GET genericClass',
    ]);
    expect(await t.ledger()).toMatchObject([{ state: 'notified' }, { state: 'notified' }]);
    expect(t.patchedMessages(mark)).toMatchObject([{ messageType: 'TEXT' }]);
    expect(t.sent()).toHaveLength(2);
  });
});

describe('retries', () => {
  it('a plain 429 retries the operation and sends the one message under the same Google id', async () => {
    const t = await messageKit(restore);
    t.mock.failNext({ status: 429, match: 'POST .*/addMessage' });
    await t.edit('One');
    expect(await t.ledger()).toMatchObject([
      { state: 'pending', reason: 'rate_limited', tries: 1 },
    ]);
    t.kit.clock.advance(120_000);
    await t.drain();
    expect(await t.ledger()).toMatchObject([{ state: 'notified', tries: 2 }]);
    const ids = t.mock.requests
      .filter((r) => r.path.endsWith('/addMessage'))
      .map((r) => (r.body as { message: { id: string } }).message.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(t.messages()).toHaveLength(1);
  });

  it('a lost fence before the request leaves the row pending, never unknown', async () => {
    const t = await messageKit(restore);
    await t.db
      .prepare(`CREATE TRIGGER gm2_stale AFTER UPDATE ON wallet_google_messages WHEN NEW.state = 'sending'
        BEGIN UPDATE passes SET row_version = row_version + 1
          WHERE id = (SELECT pass_id FROM wallet_provider_instances WHERE id = NEW.instance_id); END`)
      .run();
    await t.edit('One');
    expect(t.sent()).toEqual([]);
    expect(await t.ledger()).toMatchObject([{ state: 'pending' }]);
    expect(await t.events()).toEqual([]);
  });
});

describe('what no message is sent for', () => {
  it('a silent edit, and an update Apple sent silently over its own limit', async () => {
    const t = await messageKit(restore);
    await t.edit('Quiet', false);
    expect(t.sent()).toEqual([]);
    await t.db.prepare("UPDATE settings SET value = '1' WHERE key = 'push.budgetPerDay'").run();
    clearSettingsCache(t.db);
    await t.edit('Loud');
    await t.edit('Over');
    expect(t.sent()).toHaveLength(1);
  });

  it('a re-run of the same operation never sends its settled message again', async () => {
    const t = await messageKit(restore);
    await t.edit('One');
    expect(t.sent()).toHaveLength(1);
    // The operation ran again over the same versions (a re-queue, or a claim that expired after Google answered).
    await t.db
      .prepare(
        `UPDATE wallet_provider_instance_operations SET state = 'pending', completed_at = NULL, next_attempt_at = ?
         WHERE kind = 'upsert' AND version = (SELECT MAX(version) FROM wallet_provider_instance_operations)`,
      )
      .bind(t.kit.clock.now())
      .run();
    await t.drain();
    expect(t.sent()).toHaveLength(1);
    expect(t.calls(0).filter((c) => c === 'PATCH genericObject')).toHaveLength(2);
  });
});

describe('what leaves the log', () => {
  it('never carries the text: no log call and no event', async () => {
    const t = await messageKit(restore);
    const spies = (['info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(t.jobCtx.log, level),
    );
    await t.edit('Zanzibar Secret');
    await t.edit('Quokka Secret');
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain('Secret');
    const events = await t.db.prepare('SELECT data FROM pass_events').all();
    expect(JSON.stringify(events.results)).not.toContain('Secret');
  });
});
