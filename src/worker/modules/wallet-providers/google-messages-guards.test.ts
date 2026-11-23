// GM2 review round: the message step never fails or wedges the object write it follows, and reads what it needs exactly.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { updatePass } from '../passes/service.ts';
import { messageKit } from './google-messages-test-fixtures.ts';
import { copyGoogleProjection } from './google-projection.ts';
import { providerBudgets } from './notify-budget.ts';

let restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.reverse()) undo();
  restore = [];
  vi.unstubAllGlobals();
});

type Kit = Awaited<ReturnType<typeof messageKit>>;
const logged = (t: Kit, level: 'info' | 'warn' | 'error') => vi.spyOn(t.jobCtx.log, level);
const codes = (spy: ReturnType<typeof logged>) =>
  spy.mock.calls.map((c) => (c[1] as { code?: string } | undefined)?.code);
const upserts = (t: Kit) =>
  t.db
    .prepare(
      "SELECT state FROM wallet_provider_instance_operations WHERE kind = 'upsert' ORDER BY version",
    )
    .all()
    .then((r) => r.results.map((x) => (x as { state: string }).state));

describe('the version range', () => {
  it('names the target, not the 21st version after the base, when a backlog piled up', async () => {
    const t = await messageKit(restore);
    for (let i = 1; i <= 25; i++)
      await updatePass(
        t.jobCtx,
        { type: 'system', id: null },
        t.f.pass.id,
        {
          input: { memberName: `Name ${i}` },
          notify: true,
        },
        { scope: null },
      );
    await t.drain();
    expect(t.messages()).toMatchObject([{ body: 'Member is now Name 25' }]);
  });

  it('sends no message when the base version is gone, and the object write still completes', async () => {
    const t = await messageKit(restore);
    await t.db.prepare('UPDATE pass_versions SET pass_json = NULL WHERE version = 1').run();
    await t.edit('One');
    expect(t.sent()).toEqual([]);
    expect(t.object()).toMatchObject({ state: 'ACTIVE' });
    expect(await upserts(t)).toEqual(['succeeded', 'succeeded']);
  });
});

describe('a message step that cannot do its work', () => {
  it('skips a history row that will not decrypt, logs it, and still writes the object', async () => {
    const t = await messageKit(restore);
    await t.edit('One');
    await t.db.prepare('UPDATE wallet_google_messages SET kek_version = 99').run();
    const error = logged(t, 'error');
    t.kit.clock.advance(60_000);
    const mark = t.mock.requests.length;
    await t.edit('Two');
    expect(t.patchedMessages(mark)).toEqual([]);
    expect(codes(error)).toContain('WALLET_GOOGLE_MESSAGE_UNREADABLE');
    expect(await upserts(t)).toEqual(['succeeded', 'succeeded', 'succeeded']);
  });

  it('completes the operation when the row cannot be written, and sends nothing', async () => {
    const t = await messageKit(restore);
    await t.db
      .prepare(
        "CREATE TRIGGER gm2_nowrite BEFORE INSERT ON wallet_google_messages BEGIN SELECT RAISE(ABORT, 'no'); END",
      )
      .run();
    const error = logged(t, 'error');
    await t.edit('One');
    expect(t.sent()).toEqual([]);
    expect(codes(error)).toContain('WALLET_GOOGLE_MESSAGE_FAILED');
    expect(await upserts(t)).toEqual(['succeeded', 'succeeded']);
  });

  it('a pending row at the try cap settles failed, rate limited, and the operation completes', async () => {
    const t = await messageKit(restore);
    t.mock.failNext({ status: 429, match: 'POST .*/addMessage' });
    await t.edit('One');
    await t.db.prepare('UPDATE wallet_google_messages SET tries = 8').run();
    t.kit.clock.advance(120_000);
    await t.drain();
    expect(t.sent()).toHaveLength(1);
    expect(await t.ledger()).toMatchObject([{ state: 'failed', reason: 'rate_limited', tries: 8 }]);
    expect(await upserts(t)).toEqual(['succeeded', 'succeeded']);
  });

  it('a message that never left is failed as not_sent, logged, and the write is not retried', async () => {
    const t = await messageKit(restore);
    // The token exchange (a cached token is dropped first) fails only for the message step.
    const real = globalThis.fetch;
    let armed = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (armed && String(input).includes('oauth2.googleapis.com'))
        throw new TypeError('token endpoint down');
      if (init?.method === 'PATCH') armed = true;
      return real(input, init);
    });
    const { dropGoogleAccessToken } = await import('./google-oauth.ts');
    const account = await t.db
      .prepare("SELECT id FROM wallet_provider_accounts WHERE provider = 'google'")
      .first<{ id: string }>();
    const warn = logged(t, 'warn');
    const mark = t.mock.requests.length;
    // Drop the token after the PATCH so the message call must mint a new one.
    const patchThenDrop = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await patchThenDrop(input, init);
      if (init?.method === 'PATCH') dropGoogleAccessToken(String(account?.id));
      return response;
    });
    await t.edit('One');
    expect(t.sent()).toEqual([]);
    expect(await t.ledger()).toMatchObject([{ state: 'failed', reason: 'not_sent' }]);
    expect(codes(warn)).toContain('WALLET_GOOGLE_MESSAGE_NOT_SENT');
    expect(t.calls(mark)).toEqual(['PATCH genericObject']);
    expect(await upserts(t)).toEqual(['succeeded', 'succeeded']);
  });

  it('a failed event write is logged on its own: no GET, no unconfirmed message', async () => {
    const t = await messageKit(restore);
    await t.db
      .prepare(
        "CREATE TRIGGER gm2_noevent BEFORE INSERT ON pass_events WHEN NEW.kind = 'wallet.messaged' BEGIN SELECT RAISE(ABORT, 'no'); END",
      )
      .run();
    const error = logged(t, 'error');
    const warn = logged(t, 'warn');
    const mark = t.mock.requests.length;
    await t.edit('One');
    expect(await t.ledger()).toMatchObject([{ state: 'notified' }]);
    expect(codes(error)).toContain('WALLET_GOOGLE_MESSAGE_EVENT');
    expect(codes(warn)).not.toContain('WALLET_GOOGLE_MESSAGE_UNCONFIRMED');
    expect(t.calls(mark)).not.toContain('GET genericObject');
  });
});

describe('what the budget remembers', () => {
  it('keeps a quota refusal when the TEXT resend is refused too', async () => {
    const t = await messageKit(restore);
    t.mock.seedNotifications('genericObject', String(t.object()?.id), 3);
    const real = globalThis.fetch;
    let posts = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && String(input).endsWith('/addMessage') && ++posts === 2)
        return new Response('{}', { status: 400 });
      return real(input, init);
    });
    await t.edit('One');
    expect(await t.ledger()).toMatchObject([{ state: 'failed', reason: 'quota' }]);
    t.kit.clock.advance(60_000);
    await t.edit('Two');
    // The refused resend never reached the mock log; the next message must not ask to notify again.
    expect(t.sent()).toEqual(['TEXT_AND_NOTIFY', 'TEXT']);
  });

  it('counts a notifying message whose arrival is unknown', async () => {
    const t = await messageKit(restore);
    t.mock.failNext({ status: 503, match: 'POST .*/addMessage' });
    await t.edit('One');
    expect(await t.ledger()).toMatchObject([{ state: 'unknown' }]);
    const pass = await t.db.prepare('SELECT id FROM passes').first<{ id: string }>();
    expect(pass?.id).toBe(t.f.pass.id);
    const { getPass } = await import('../passes/repo-read-pass.ts');
    const budget = await providerBudgets(t.kit.ctx, (await getPass(t.db, t.f.pass.id)) ?? t.f.pass);
    expect(budget.google).toMatchObject({ used: 1, limit: 3 });
  });

  it('leaves messages out of the write while a message in doubt is unresolved', async () => {
    const t = await messageKit(restore);
    t.mock.failNext({ status: 503, match: 'POST .*/addMessage' });
    t.mock.failNext({ status: 500, match: 'GET /walletobjects/v1/genericObject' });
    await t.edit('One');
    expect(await t.ledger()).toMatchObject([{ state: 'sending' }]);
    t.kit.clock.advance(60_000);
    t.mock.failNext({ status: 500, match: 'GET /walletobjects/v1/genericObject' });
    const mark = t.mock.requests.length;
    await t.edit('Two');
    const patch = t.mock.requests.slice(mark).find((r) => r.method === 'PATCH');
    expect(patch?.body).not.toHaveProperty('messages');
  });
});

describe('the write guard', () => {
  it('refuses a notifying message inside an insert, PATCH or PUT body', () => {
    const body = (messageType: string) => ({
      state: 'ACTIVE',
      messages: [{ id: 'a', messageType }],
    });
    expect(() => copyGoogleProjection(body('TEXT_AND_NOTIFY') as never)).toThrow();
    expect(copyGoogleProjection(body('TEXT') as never)).toMatchObject({ messages: [{ id: 'a' }] });
  });
});
