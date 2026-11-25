import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { clockedHub } from './clocked-hub-test-fixtures.ts';
import { liveReadyId } from './live.ts';
import { sealLiveAttachment } from './live-attachment.ts';
import type { LiveAttachment } from './live-auth.ts';
import { type SessionLiveFixtures, sessionLiveFixtures } from './session-live-test-fixtures.ts';
import { key } from './test-kit.ts';

let f: SessionLiveFixtures;
let template: string;
beforeAll(async () => {
  f = await sessionLiveFixtures();
  template = await f.kit.scanTemplate('Draft hub', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

const hub = () => clockedHub(f.kit.ctx, f.kit.clock, f.kit.org.id, 'live');
const say = { headline: 'To pay', sub: 'Balance after: $30.50', figure: '$12.00' };

/** A socket on the hub that records every message it is sent. */
async function listen(attachment: LiveAttachment) {
  const response = await hub().fetch(
    new Request('https://hub.test', {
      headers: {
        upgrade: 'websocket',
        'x-pb-live': await sealLiveAttachment(f.kit.env, attachment),
      },
    }),
  );
  const socket = response.webSocket;
  if (response.status !== 101 || !socket) throw new Error('The screen did not connect.');
  const messages: Record<string, unknown>[] = [];
  socket.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data))));
  socket.accept();
  return {
    messages,
    drafts: () => messages.filter((m) => 'draft' in m),
    close: () => socket.close(1000),
  };
}

/** One session with a counter scanner, a customer screen and a monitor, and a ready card on the counter. */
async function counter(name: string, customer: Record<string, unknown> = {}) {
  const session = await f.parent(name);
  if (Object.keys(customer).length) {
    const stored = await first<{ settings: string }>(
      f.kit.env.DB,
      'SELECT settings FROM scanning_sessions WHERE id=?',
      [session.id],
    );
    await run(f.kit.env.DB, 'UPDATE scanning_sessions SET settings=? WHERE id=?', [
      JSON.stringify({ ...JSON.parse(stored?.settings ?? '{}'), customer }),
      session.id,
    ]);
  }
  const source = await f.child(session.id, `${name} counter`);
  const screen = await listen(await f.pairedAttachment(session.id, `${name} screen`, 'customer'));
  const monitor = await listen(await f.pairedAttachment(session.id, `${name} monitor`, 'desk'));
  const pass = await f.kit.scanPass(template, { memberName: 'Anna Popescu' });
  const ref = key();
  const readyId = await liveReadyId(source.id, ref);
  const ready = async (
    more: Parameters<SessionLiveFixtures['row']>[0] extends string ? object : never = {},
  ) => {
    const entry = await f.withSourceProof({
      ...f.row(source.id),
      id: readyId,
      kind: 'ready',
      label: 'Choose an action',
      passId: pass.id,
      ...more,
    });
    expect(await hub().publish({ orgId: f.kit.org.id, mode: 'live', row: entry })).toBe(true);
    return entry;
  };
  const input = { orgId: f.kit.org.id, mode: 'live' as const, readyId, scannerId: source.id };
  return { session, source, screen, monitor, pass, readyId, ready, input };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('a draft over a ready card', () => {
  it('reaches the customer screen that follows the scanner, and no monitor, and keeps no ring row', async () => {
    const c = await counter('Draft reach');
    await c.ready();
    // The test clock is behind the runtime's, so the ring's alarm runs at once: draft before waiting.
    expect(await hub().draft({ ...c.input, say })).toBe(1);
    // Not in the ring or a snapshot: the ready card stays the one row a screen could replay.
    expect((await hub().ringRow(c.readyId))?.row.kind).toBe('ready');
    const late = await f.pairedAttachment(c.session.id, 'Draft reach late', 'customer');
    expect((await hub().snapshot(late)).rows).toEqual([]);
    const watcher = await f.pairedAttachment(c.session.id, 'Draft reach watcher', 'desk');
    expect((await hub().snapshot(watcher)).rows.map((r) => r.id)).toEqual([c.readyId]);
    await settle();
    expect(c.screen.drafts()).toHaveLength(1);
    expect(c.screen.drafts()[0]).toMatchObject({
      draft: {
        ref: c.readyId,
        scannerId: c.source.id,
        customer: {
          screen: 'review',
          band: { headline: 'To pay', sub: 'Balance after: $30.50' },
          figure: '$12.00',
          greet: 'Hi, Anna',
          ref: c.readyId,
        },
      },
    });
    expect(JSON.stringify(c.screen.drafts())).not.toMatch(/Popescu/);
    expect(c.monitor.drafts()).toEqual([]);
    for (const s of [c.screen, c.monitor]) s.close();
  });

  it('refuses a read that is old, another scanner, not presented or not a ready card', async () => {
    const c = await counter('Draft stale');
    expect(await hub().draft({ ...c.input, say })).toBeNull();
    await c.ready({ presented: false });
    expect(await hub().draft({ ...c.input, say })).toBeNull();
    const other = await f.child(c.session.id, 'Draft stale other');
    await c.ready();
    expect(await hub().draft({ ...c.input, scannerId: other.id, say })).toBeNull();
    f.kit.clock.advance(61_000);
    expect(await hub().draft({ ...c.input, say })).toBeNull();
    expect(c.screen.drafts()).toEqual([]);
    for (const s of [c.screen, c.monitor]) s.close();
  });

  it('sends nothing for a ready card of no pass or one whose pass moved on', async () => {
    const c = await counter('Draft pass');
    await c.ready({ passId: null });
    expect(await hub().draft({ ...c.input, say })).toBeNull();
    const kept = await counter('Draft revoked');
    await kept.ready();
    await run(f.kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [kept.pass.id]);
    await run(
      f.kit.env.DB,
      'UPDATE passes SET lifecycle_generation=lifecycle_generation+1 WHERE id=?',
      [kept.pass.id],
    );
    expect(await hub().draft({ ...kept.input, say })).toBe(0);
    await settle();
    expect(kept.screen.drafts()).toEqual([]);
    expect(
      await first(f.kit.env.DB, 'SELECT 1 FROM passes WHERE id=?', [kept.pass.id]),
    ).not.toBeNull();
    for (const s of [c.screen, c.monitor, kept.screen, kept.monitor]) s.close();
  });

  it('never reaches a screen of another session', async () => {
    const a = await counter('Draft session A');
    const b = await counter('Draft session B');
    await a.ready();
    expect(await hub().draft({ ...a.input, say })).toBe(1);
    await settle();
    expect(a.screen.drafts()).toHaveLength(1);
    expect(b.screen.drafts()).toEqual([]);
    for (const s of [a.screen, a.monitor, b.screen, b.monitor]) s.close();
  });

  it('is withheld by a session that hides drafts, and the ready card stays', async () => {
    const c = await counter('Draft hidden', { showDraft: false });
    await c.ready();
    expect(await hub().draft({ ...c.input, say })).toBe(0);
    await settle();
    expect(c.screen.drafts()).toEqual([]);
    for (const s of [c.screen, c.monitor]) s.close();
  });

  it('cancels with the ready card to the followers only, and clears nothing for another scanner', async () => {
    const c = await counter('Draft cancel');
    await c.ready();
    expect(await hub().draft({ ...c.input, say })).toBe(1);
    expect(await hub().clearDraft(c.input)).toBe(1);
    await settle();
    expect(c.screen.drafts().at(-1)).toMatchObject({
      draft: { ref: c.readyId, cancelled: true },
    });
    expect(c.monitor.drafts()).toEqual([]);
    const other = await f.child(c.session.id, 'Draft cancel other');
    expect(await hub().clearDraft({ ...c.input, scannerId: other.id })).toBe(0);
    for (const s of [c.screen, c.monitor]) s.close();
  });

  it('a draft-only cancel says keep, and a result after the read makes a later draft stale', async () => {
    const c = await counter('Draft keep');
    const entry = await c.ready();
    expect(await hub().draft({ ...c.input, say })).toBe(1);
    expect(await hub().clearDraft({ ...c.input, keep: 'ready' })).toBe(1);
    await settle();
    expect(c.screen.drafts().at(-1)).toMatchObject({
      draft: { ref: c.readyId, cancelled: true, keep: 'ready' },
    });
    // The desk committed: its receipt row is newer than the ready card.
    f.kit.clock.advance(1_000);
    const receipt = await f.withSourceProof({
      ...f.row(c.source.id),
      id: key(),
      kind: 'ok',
      at: entry.row.at + 500,
    });
    expect(await hub().publish({ orgId: f.kit.org.id, mode: 'live', row: receipt })).toBe(true);
    expect(await hub().draft({ ...c.input, say })).toBeNull();
    for (const s of [c.screen, c.monitor]) s.close();
  });

  it("is stale once the same desk's next read has a ready card, but not for another desk", async () => {
    const c = await counter('Draft next read');
    const entry = await c.ready();
    expect(await hub().draft({ ...c.input, say })).toBe(1);
    const next = await f.withSourceProof({
      ...f.row(c.source.id),
      id: key(),
      kind: 'ready',
      passId: c.pass.id,
      at: entry.row.at + 500,
    });
    expect(await hub().publish({ orgId: f.kit.org.id, mode: 'live', row: next })).toBe(true);
    expect(await hub().draft({ ...c.input, say })).toBeNull();
    for (const s of [c.screen, c.monitor]) s.close();
  });
});
