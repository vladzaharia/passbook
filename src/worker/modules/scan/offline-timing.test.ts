import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { all, run, stmt } from '../../platform/db.ts';
import { makeDoor } from './access-test-fixtures.ts';
import { kit, setupActionFixture } from './act-test-fixtures.ts';
import { batch, batchOf, item, ticketTemplate } from './offline-test-fixtures.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

const MIN = 60_000;
const rowsOf = (sql: string, params: (string | number)[] = []) =>
  all<Record<string, unknown>>(kit.env.DB, sql, params);

/** A paired door in its own session, in Staff decide mode since long ago. */
async function door() {
  const tpl = await ticketTemplate();
  const d = await makeDoor([tpl]);
  await run(
    kit.env.DB,
    `UPDATE scanning_sessions SET settings = json_set(settings, '$.whenOffline', 'decide'), updated_at = 1
     WHERE id = ?`,
    [d.sessionId],
  );
  return { ...d, tpl };
}

describe('the session change log', () => {
  it('is written in the same statement as the edit, and a rolled-back edit leaves nothing', async () => {
    const { sessionId } = await door();
    const changes = () =>
      rowsOf('SELECT status, prev_status, mode FROM scan_session_changes WHERE session_id = ?', [
        sessionId,
      ]);
    const before = (await changes()).length;
    await expect(
      kit.env.DB.batch([
        stmt(
          kit.env.DB,
          "UPDATE scanning_sessions SET status = 'paused', updated_at = 5 WHERE id = ?",
          [sessionId],
        ),
        stmt(kit.env.DB, "INSERT INTO scanning_sessions (id) VALUES ('not a session')"),
      ]),
    ).rejects.toThrow();
    expect(await changes()).toHaveLength(before);
    await run(
      kit.env.DB,
      "UPDATE scanning_sessions SET status = 'paused', updated_at = 5 WHERE id = ?",
      [sessionId],
    );
    expect((await changes()).at(-1)).toEqual({
      status: 'paused',
      prev_status: 'active',
      mode: 'decide',
    });
  });

  it('an edit that changes nothing a read depends on writes no row', async () => {
    const { sessionId } = await door();
    const count = async () =>
      (await rowsOf('SELECT 1 FROM scan_session_changes WHERE session_id = ?', [sessionId])).length;
    const before = await count();
    await run(
      kit.env.DB,
      "UPDATE scanning_sessions SET name = 'Renamed', updated_at = 9 WHERE id = ?",
      [sessionId],
    );
    expect(await count()).toBe(before);
  });
});

describe('hours and holds are judged as they were when the door took the read', () => {
  it('a Close now made later does not close earlier reads, and closes the ones after it', async () => {
    const { tpl, sessionId, headers } = await door();
    const [early, late] = [await kit.scanPass(tpl), await kit.scanPass(tpl)];
    const now = kit.clock.now();
    const hold = JSON.stringify({ state: 'closed', until: now + 60 * MIN });
    await run(kit.env.DB, 'UPDATE scanning_sessions SET hold = ?, updated_at = ? WHERE id = ?', [
      hold,
      now - 10 * MIN,
      sessionId,
    ]);
    const [a, b] = (
      await batchOf(
        await batch(headers, [
          item(early.scanCode ?? '', { clientTs: now - 30 * MIN, door: 'unverified' }),
          item(late.scanCode ?? '', { clientTs: now - 5 * MIN, door: 'unverified' }),
        ]),
      )
    ).items;
    expect(a?.outcome.kind).toBe('ok');
    expect(b).toMatchObject({ conflict: true, outcome: { kind: 'heads_up', reason: 'ended' } });
  });

  it('an Open now made later does not open reads taken while the hours were closed', async () => {
    const { tpl, sessionId, headers } = await door();
    const [closed, open] = [await kit.scanPass(tpl), await kit.scanPass(tpl)];
    const now = kit.clock.now();
    // Closed by a hold until a manager opened it early, 10 minutes ago.
    await run(kit.env.DB, 'UPDATE scanning_sessions SET hold = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify({ state: 'closed', until: now + 600 * MIN }),
      now - 60 * MIN,
      sessionId,
    ]);
    await run(kit.env.DB, 'UPDATE scanning_sessions SET hold = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify({ state: 'open', until: now + 600 * MIN }),
      now - 10 * MIN,
      sessionId,
    ]);
    const [a, b] = (
      await batchOf(
        await batch(headers, [
          item(closed.scanCode ?? '', { clientTs: now - 30 * MIN, door: 'unverified' }),
          item(open.scanCode ?? '', { clientTs: now - 5 * MIN, door: 'unverified' }),
        ]),
      )
    ).items;
    expect(a).toMatchObject({ conflict: true, outcome: { reason: 'ended' } });
    expect(b?.outcome.kind).toBe('ok');
  });
});
