import { expect, it } from 'vitest';
import { makePass } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { act, CHECK_IN, expectUnavailable, kit, out, rows, tpl } from './act-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

export function registerConcurrency() {
  it('ten competing scanners produce one ok and nine already_done, with no stale refusal', async () => {
    const scanners = await Promise.all(
      Array.from({ length: 10 }, () => kit.scanner({ templateIds: [tpl] })),
    );
    const pass = await kit.scanPass(tpl);
    const attempts = scanners.map((scanner) => ({ scanner, idempotencyKey: key() }));
    const results = await Promise.all(
      attempts.map(async (attempt) => {
        const response = await act(attempt.scanner.headers, codeOf(pass), {
          idempotencyKey: attempt.idempotencyKey,
        });
        expect(response.status).toBe(200);
        return { ...attempt, outcome: await out(response) };
      }),
    );
    const winners = results.filter(({ outcome }) => outcome.kind === 'ok');
    const held = results.filter(({ outcome }) => outcome.kind === 'heads_up');
    const stale = results.filter(({ outcome }) => outcome.kind === 'refused');
    expect(winners).toHaveLength(1);
    expect(held).toHaveLength(9);
    expect(stale).toHaveLength(0);
    const winningAttempt = winners[0];
    if (!winningAttempt) throw new Error('Missing winning attempt');
    const winner = winningAttempt.outcome;
    expect(winner.scanId).toEqual(expect.any(String));
    for (const { outcome } of held) {
      expect(outcome).toMatchObject({
        reason: 'already_done',
        previous: { scanId: winner.scanId, at: kit.clock.now() },
      });
      expect(outcome.scanId).toEqual(expect.any(String));
    }
    for (const { outcome } of stale) expectUnavailable(outcome);

    for (const { scanner, idempotencyKey, outcome } of results) {
      const scan = await first<{
        id: string;
        state: string;
        outcome: string | null;
        reason: string | null;
        pass_id: string | null;
      }>(
        kit.env.DB,
        'SELECT id,state,outcome,reason,pass_id FROM scans WHERE actor_key=? AND idempotency_key=?',
        [`s:${scanner.id}`, idempotencyKey],
      );
      if (outcome.kind === 'refused') {
        if (scan)
          expect(scan).toMatchObject({
            state: 'failed',
            outcome: null,
            reason: 'stale',
            pass_id: null,
          });
        else expect(scan).toBeNull();
        expect(
          await rows(
            `SELECT proof.scan_id FROM scan_retention_proofs proof
          JOIN scans q ON q.id=proof.scan_id WHERE q.actor_key=? AND q.idempotency_key=?`,
            [`s:${scanner.id}`, idempotencyKey],
          ),
        ).toHaveLength(0);
      } else {
        expect(scan).toMatchObject({
          id: outcome.scanId,
          state: 'done',
          outcome: outcome.kind,
          reason: outcome.reason,
          pass_id: pass.id,
        });
      }
    }
    expect(
      await first(kit.env.DB, 'SELECT state,count,last_scan_id FROM scan_gates WHERE pass_id=?', [
        pass.id,
      ]),
    ).toEqual({ state: 'in', count: 1, last_scan_id: winner.scanId });
    expect(await rows('SELECT pass_id FROM scan_presence WHERE pass_id=?', [pass.id])).toHaveLength(
      0,
    );
    const ledger = await rows<{ kind: string; data: string }>(
      "SELECT kind,data FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'",
      [pass.id],
    );
    expect(ledger.filter((event) => event.kind === 'scan.checked_in')).toHaveLength(1);
    expect(ledger.filter((event) => event.kind === 'scan.heads_up')).toHaveLength(held.length);
    expect(ledger).toHaveLength(1 + held.length);
    expect(ledger.map((event) => JSON.parse(event.data).scanId).sort()).toEqual(
      [winner.scanId, ...held.map(({ outcome }) => outcome.scanId)].sort(),
    );
  });

  it('the all_in milestone fires exactly once when the last pass arrives together', async () => {
    const t = await kit.scanTemplate('Ticket', { actions: [CHECK_IN] });
    const ev = await kit.event({ templateIds: [t] });
    const passes = await Promise.all(Array.from({ length: 4 }, () => kit.scanPass(t)));
    const scanners = await Promise.all(passes.map(() => kit.scanner({ eventId: ev.id })));
    const results = await Promise.all(
      passes.map(async (p, i) => out(await act(scanners[i]?.headers ?? {}, codeOf(p)))),
    );
    expect(results.every((r) => r.kind === 'ok')).toBe(true);
    expect(results.filter((r) => r.milestone === 'all_in')).toHaveLength(1);
    expect(Math.max(...results.map((r) => r.counts.event?.arrived ?? 0))).toBe(4);
  });

  it('the count milestone fires once, on the 100th arrival', async () => {
    const t = await kit.scanTemplate('Crowd', { actions: [CHECK_IN] });
    const ev = await kit.event({ templateIds: [t] });
    const template = await kit.registry.resolve(t);
    for (let i = 0; i < 98; i++) {
      const seed = await makePass(kit.fx, { orgId: kit.org.id, template });
      await run(
        kit.env.DB,
        `INSERT INTO scan_gates (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
         VALUES (?, ?, ?, ?, 'live', ?, 'check_in', 'in', 1, 1, 1, 'seed')`,
        [seed.id, `seed${i}`, `event:${ev.id}`, kit.org.id, t],
      );
    }
    const passes = await Promise.all(Array.from({ length: 5 }, () => kit.scanPass(t)));
    const scanners = await Promise.all(passes.map(() => kit.scanner({ eventId: ev.id })));
    const results = await Promise.all(
      passes.map(async (p, i) => out(await act(scanners[i]?.headers ?? {}, codeOf(p)))),
    );
    const hits = results.filter((r) => r.milestone === 'count');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.counts.event?.arrived).toBe(100);
  });
}
