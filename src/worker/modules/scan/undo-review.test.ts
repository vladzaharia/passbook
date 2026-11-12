import { describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import {
  actorFor,
  kit,
  raceBatch,
  type Scenario,
  scanAgain,
  scenario,
  templateId,
} from './repo-undo-authority-test-fixtures.ts';
import { key } from './test-kit.ts';
import { undo } from './undo.ts';

const DAY = 86_400_000;
const presenceOf = (s: Scenario) =>
  first<{ state: string; last_scan_id: string; prev_state: string | null }>(
    kit.env.DB,
    'SELECT state,last_scan_id,prev_state FROM scan_presence WHERE pass_id=?',
    [s.pass.id],
  );
const gatesOf = (s: Scenario) =>
  all<{ scope: string; prev_state: string | null; state: string; last_scan_id: string }>(
    kit.env.DB,
    'SELECT scope,prev_state,state,last_scan_id FROM scan_gates WHERE pass_id=? ORDER BY scope',
    [s.pass.id],
  );

describe('undo when the gate is new but the presence row has history', () => {
  it.each([
    ['a daily check-in setting on an event-bound scanner', { mode: 'daily' }, false],
    ['direction both with no check-in mode and a daily action', null, true],
  ] as const)('restores day 1 presence on day 2: %s', async (_label, checkIn, dailyAction) => {
    const event = await kit.event({ templateIds: [templateId] });
    await run(kit.env.DB, 'UPDATE scan_events SET closes_at=? WHERE id=?', [
      kit.clock.now() + 10 * DAY,
      event.id,
    ]);
    const template = dailyAction
      ? await kit.scanTemplate('Daily undo', {
          actions: [{ id: 'enter', label: 'Check in', kind: 'check_in', repeat: 'daily' }],
        })
      : templateId;
    if (dailyAction)
      await run(kit.env.DB, 'DELETE FROM scan_event_templates WHERE event_id=?', [event.id]);
    if (dailyAction)
      await run(
        kit.env.DB,
        'INSERT INTO scan_event_templates (event_id,template_id) VALUES (?,?)',
        [event.id, template],
      );
    const s = await scenario(event.id, undefined, undefined, 'live', checkIn, template);
    kit.clock.advance(DAY);
    const day2 = await scanAgain(s);
    expect({ k: day2.kind, r: day2.reason }).toEqual({ k: 'ok', r: null });
    // The shape of the bug: the newest gate has no history, the presence row does.
    const newest = (await gatesOf(s)).find((g) => g.last_scan_id === day2.scanId);
    if (dailyAction) {
      expect(newest?.prev_state).toBeNull();
      expect((await presenceOf(s))?.prev_state).not.toBeNull();
    }
    const result = await undo(kit.ctx, s.actor, day2.scanId ?? '', { idempotencyKey: key() });
    expect(result.outcome).toMatchObject({ kind: 'ok', replay: false });
    expect((await presenceOf(s))?.last_scan_id).toBe(s.targetId);
    expect((await presenceOf(s))?.prev_state).toBeNull();
  });

  it('undoes after gate recovery cleared the gate history', async () => {
    const s = await scenario();
    const exit = await scanAgain(s);
    await run(
      kit.env.DB,
      'UPDATE scan_gates SET prev_state=NULL,prev_last_at=NULL,prev_scan_id=NULL,last_at=last_at-7 WHERE pass_id=?',
      [s.pass.id],
    );
    const result = await undo(kit.ctx, s.actor, exit.scanId ?? '', { idempotencyKey: key() });
    expect(result.outcome).toMatchObject({ kind: 'ok', replay: false });
    expect(await presenceOf(s)).toMatchObject({ state: 'in', last_scan_id: s.targetId });
  });
});

describe('undo retries and races', () => {
  it('retries after a re-scan: a replay that leaves the new check-in alone', async () => {
    const s = await scenario();
    const req = { idempotencyKey: key() };
    const first1 = await undo(kit.ctx, s.actor, s.targetId, req);
    const again = await scanAgain(s);
    expect(again).toMatchObject({ kind: 'ok' });
    const retry = await undo(kit.ctx, s.actor, s.targetId, req);
    expect(retry.outcome).toMatchObject({
      kind: 'ok',
      replay: true,
      scanId: first1.outcome.scanId,
    });
    expect(
      await first(kit.env.DB, 'SELECT undone_by FROM scans WHERE id=?', [again.scanId ?? '']),
    ).toEqual({ undone_by: null });
  });

  it('answers a same-key race deterministically: the loser replays the winner', async () => {
    const s = await scenario();
    const req = { idempotencyKey: key() };
    let winner: string | undefined;
    const race = raceBatch('UPDATE scan_gates SET state', async () => {
      winner = (await undo(kit.ctx, s.actor, s.targetId, req)).outcome.scanId ?? undefined;
    });
    const loser = await undo(race.ctx, s.actor, s.targetId, req);
    expect(race.raced()).toBe(true);
    expect(loser.outcome).toMatchObject({ kind: 'ok', replay: true, scanId: winner });
    expect(
      await all(kit.env.DB, 'SELECT id FROM scans WHERE idempotency_key=?', [req.idempotencyKey]),
    ).toHaveLength(1);
  });

  it("does not find another organization's scan and writes nothing", async () => {
    const s = await scenario();
    const other = await makeOrg(kit.fx);
    const foreign = await kit.scanner({ orgId: other.id, templateIds: [] });
    const actor = await actorFor(foreign.id);
    const before = await all(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id=?', [s.pass.id]);
    const undoKey = key();
    await expect(
      undo(kit.ctx, actor, s.targetId, { idempotencyKey: undoKey }),
    ).rejects.toMatchObject({ status: 404, code: 'SCAN_NOT_FOUND' });
    expect(await all(kit.env.DB, 'SELECT * FROM scan_gates WHERE pass_id=?', [s.pass.id])).toEqual(
      before,
    );
    expect(
      await first(kit.env.DB, 'SELECT id FROM scans WHERE idempotency_key=?', [undoKey]),
    ).toBeNull();
    expect(await first(kit.env.DB, 'SELECT undone_by FROM scans WHERE id=?', [s.targetId])).toEqual(
      { undone_by: null },
    );
  });

  it("refuses a replay of another organization's undo under the same admin key", async () => {
    const s = await scenario();
    const req = { idempotencyKey: key() };
    const done = await undo(kit.ctx, s.actor, s.targetId, req);
    const other = await makeOrg(kit.fx);
    const foreign = await kit.scanner({ orgId: other.id, templateIds: [] });
    const actor = await actorFor(foreign.id);
    // Same actor key and idempotency key, different org: the stored row is not this actor's.
    actor.actorKey = s.actor.actorKey;
    await expect(undo(kit.ctx, actor, s.targetId, req)).rejects.toMatchObject({
      status: 422,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(done.outcome.scanId).toBeTruthy();
  });

  it('refuses a key already used by a check-in', async () => {
    const s = await scenario();
    const used = await first<{ idempotency_key: string }>(
      kit.env.DB,
      'SELECT idempotency_key FROM scans WHERE id=?',
      [s.targetId],
    );
    await expect(
      undo(kit.ctx, s.actor, s.targetId, { idempotencyKey: used?.idempotency_key ?? '' }),
    ).rejects.toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});

describe('undo over the wire', () => {
  it('keeps secrets out of the undo scan, ledger and audit rows', async () => {
    const s = await scenario();
    const done = await undo(kit.ctx, s.actor, s.targetId, { idempotencyKey: key() });
    const secrets = await first<{ csrf_secret: string | null; token_hash: string | null }>(
      kit.env.DB,
      'SELECT csrf_secret,token_hash FROM scanners WHERE id=?',
      [s.scanner.id],
    );
    const rows = JSON.stringify([
      await all(kit.env.DB, 'SELECT * FROM scans WHERE id=?', [done.outcome.scanId ?? '']),
      await all(kit.env.DB, "SELECT * FROM pass_events WHERE kind='scan.undone' AND pass_id=?", [
        s.pass.id,
      ]),
      await all(kit.env.DB, "SELECT * FROM audit_log WHERE action='scan.undo'"),
    ]);
    for (const secret of [secrets?.csrf_secret, secrets?.token_hash])
      if (secret) expect(rows).not.toContain(secret);
    expect(rows).not.toMatch(/csrf|session|token/i);
  });

  it('refuses a retry from a scanner revoked after the undo', async () => {
    const s = await scenario();
    const req = { idempotencyKey: key() };
    const path = `/scans/${s.targetId}/undo`;
    expect((await kit.post(s.scanner.headers, path, req)).status).toBe(200);
    await run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
      kit.clock.now(),
      s.scanner.id,
    ]);
    expect((await kit.post(s.scanner.headers, path, req)).status).toBe(401);
  });
});
