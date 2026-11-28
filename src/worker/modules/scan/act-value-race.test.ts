import { beforeAll, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { act, kit, out, rows, setupActionFixture } from './act-test-fixtures.ts';
import { showBalance } from './act-value-test-fixtures.ts';
import { RACE_GATE_WRITE } from './race-tags.ts';
import { beforeBatch } from './repo-action-template-read-race-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(setupActionFixture);

const ADD = { id: 'add', label: 'Add', kind: 'add', input: 'balance', repeat: 'always' } as const;
const desk = (templateIds: string[]) =>
  kit.scanner({ templateIds, settings: { roleWithoutSignIn: 'desk' } });
const balanceOf = async (passId: string) =>
  (
    JSON.parse(
      (
        await first<{ personalization: string }>(
          kit.env.DB,
          'SELECT personalization FROM passes WHERE id = ?',
          [passId],
        )
      )?.personalization ?? '{}',
    ) as { balance?: number }
  ).balance;
const count = async (sql: string, params: (string | number)[]) =>
  (await first<{ n: number }>(kit.env.DB, sql, params))?.n ?? 0;

describe('value actions: races', () => {
  it('20 concurrent add +1 give +20, or a PASS_CONFLICT for each one that is missing', async () => {
    const t = await kit.scanTemplate('Race', { actions: [{ ...ADD, amount: 1 }] });
    await showBalance(t);
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 0 });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => act(s.headers, codeOf(pass), { actionId: 'add' })),
    );
    const oks: number[] = [];
    const conflicts: string[] = [];
    for (const res of results) {
      if (res.status === 200 && (await out(res)).kind === 'ok') oks.push(1);
      else conflicts.push(((await res.json()) as { code: string }).code);
    }
    expect(conflicts.every((code) => code === 'PASS_CONFLICT')).toBe(true);
    expect(oks).toHaveLength(20 - conflicts.length);
    expect(await balanceOf(pass.id)).toBe(oks.length);
    // each applied add is one done ok scan, one version, one ledger event; the losers wrote nothing
    expect(
      await count("SELECT COUNT(*) AS n FROM scans WHERE pass_id = ? AND outcome = 'ok'", [
        pass.id,
      ]),
    ).toBe(oks.length);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM pass_events WHERE pass_id = ? AND kind = 'scan.adjusted'",
        [pass.id],
      ),
    ).toBe(oks.length);
    expect(
      await count("SELECT COUNT(*) AS n FROM scans WHERE pass_id = ? AND state = 'pending'", [
        pass.id,
      ]),
    ).toBe(0);
    expect(await count('SELECT version AS n FROM passes WHERE id = ?', [pass.id])).toBe(
      pass.version + oks.length,
    );
  });

  it('two concurrent use_up void the pass once', async () => {
    const t = await kit.scanTemplate('Race coupon', {
      actions: [{ id: 'use', label: 'Use', kind: 'use_up' }],
    });
    const s = await desk([t]);
    const pass = await kit.scanPass(t);
    const results = await Promise.all(
      [0, 1].map(() => act(s.headers, codeOf(pass), { actionId: 'use' })),
    );
    const outcomes = await Promise.all(
      results.map(async (res) => (res.status === 200 ? await out(res) : null)),
    );
    expect(outcomes.filter((o) => o?.kind === 'ok')).toHaveLength(1);
    expect(
      await count("SELECT COUNT(*) AS n FROM scans WHERE pass_id = ? AND outcome = 'ok'", [
        pass.id,
      ]),
    ).toBe(1);
    expect(
      await count("SELECT COUNT(*) AS n FROM pass_versions WHERE pass_id = ? AND source = 'scan'", [
        pass.id,
      ]),
    ).toBe(1);
  });

  it('a crash after the artifact is stored and before the write leaves the scan failed, and a replay applies once', async () => {
    const t = await kit.scanTemplate('Crash', { actions: [{ ...ADD, amount: 1 }] });
    await showBalance(t);
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 0 });
    const real = kit.env.DB;
    let thrown = false;
    kit.env.DB = new Proxy(real, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            // The artifact is already in R2 when the batch with the pass write arrives.
            if (
              !thrown &&
              (await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/v2-` })).objects.length
            ) {
              thrown = true;
              throw new Error('D1 went away');
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const idempotencyKey = key();
    let first1: Response;
    try {
      first1 = await act(s.headers, codeOf(pass), { actionId: 'add', idempotencyKey });
    } finally {
      kit.env.DB = real;
    }
    expect(thrown).toBe(true);
    expect(first1.status).toBe(500);
    expect(await balanceOf(pass.id)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM scan_gates WHERE pass_id = ?', [pass.id])).toBe(
      0,
    );
    const [failed] = await rows<{ state: string }>(
      'SELECT state FROM scans WHERE idempotency_key = ?',
      [idempotencyKey],
    );
    expect(failed?.state).toBe('failed');
    const retry = await out(
      await act(s.headers, codeOf(pass), { actionId: 'add', idempotencyKey }),
    );
    expect(retry).toMatchObject({ kind: 'ok', value: { before: 0, after: 1 } });
    const again = await out(
      await act(s.headers, codeOf(pass), { actionId: 'add', idempotencyKey }),
    );
    expect(again).toMatchObject({ kind: 'ok', replay: true });
    expect(await balanceOf(pass.id)).toBe(1);
  });
});

describe('value actions: the daily amount', () => {
  it('concurrent adds at the cap never pass it', async () => {
    const t = await kit.scanTemplate('Cap race', { actions: [{ ...ADD, amount: 1 }] });
    await showBalance(t);
    const s = await kit.scanner({
      templateIds: [t],
      settings: { roleWithoutSignIn: 'desk', dailyAmount: 3 },
    });
    const pass = await kit.scanPass(t, { balance: 0 });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => act(s.headers, codeOf(pass), { actionId: 'add' })),
    );
    const kinds: string[] = [];
    for (const res of results) {
      if (res.status === 200) {
        const o = await out(res);
        kinds.push(o.kind === 'ok' ? 'ok' : String(o.reason));
      } else kinds.push(((await res.json()) as { code: string }).code);
    }
    const oks = kinds.filter((k) => k === 'ok').length;
    expect(oks).toBeLessThanOrEqual(3);
    expect(oks).toBeGreaterThan(0);
    expect(
      kinds.filter((k) => k !== 'ok').every((k) => ['limit_reached', 'PASS_CONFLICT'].includes(k)),
    ).toBe(true);
    expect(await balanceOf(pass.id)).toBe(oks);
    expect(
      await count(
        "SELECT COALESCE(SUM(amount), 0) AS n FROM scans WHERE pass_id = ? AND outcome = 'ok'",
        [pass.id],
      ),
    ).toBe(oks);
  });
});

describe('value actions: push budget', () => {
  it('a default add leaves the budget; notify: true counts and the fourth in 24 h goes out silent', async () => {
    const quiet = await kit.scanTemplate('Quiet', { actions: [{ ...ADD, amount: 1 }] });
    const loud = await kit.scanTemplate('Loud', { actions: [{ ...ADD, amount: 1, notify: true }] });
    await showBalance(quiet, { message: true });
    await showBalance(loud, { message: true });
    const sQuiet = await desk([quiet]);
    const sLoud = await desk([loud]);
    const quietPass = await kit.scanPass(quiet, { balance: 0 });
    const loudPass = await kit.scanPass(loud, { balance: 0 });
    const notified = (passId: string) =>
      count(
        "SELECT COUNT(*) AS n FROM pass_events WHERE pass_id = ? AND kind = 'pass.updated' AND json_extract(data, '$.notified') = 1",
        [passId],
      );
    const silenced = (passId: string) =>
      count(
        "SELECT COUNT(*) AS n FROM pass_events WHERE pass_id = ? AND kind = 'pass.updated' AND json_extract(data, '$.overBudget') = 1",
        [passId],
      );
    for (let i = 0; i < 5; i++)
      expect(
        (await out(await act(sQuiet.headers, codeOf(quietPass), { actionId: 'add' }))).kind,
      ).toBe('ok');
    expect(await notified(quietPass.id)).toBe(0);
    for (let i = 0; i < 5; i++)
      expect(
        (await out(await act(sLoud.headers, codeOf(loudPass), { actionId: 'add' }))).kind,
      ).toBe('ok');
    expect(await notified(loudPass.id)).toBe(3);
    expect(await silenced(loudPass.id)).toBe(2);
    expect(await balanceOf(loudPass.id)).toBe(5);
  });

  // The value commit holds the release the answer was evaluated under (the grant's own check).
  it.each(['other release', 'identical republish'] as const)(
    'a %s between the preflight and the value commit',
    async (change) => {
      const t = await kit.scanTemplate('Release race', { actions: [{ ...ADD, amount: 1 }] });
      await showBalance(t);
      const pinned = await kit.registry.resolve(t, 'v2');
      const manifest = structuredClone(pinned.manifest);
      manifest.scan = { actions: [{ ...ADD, amount: 1, label: 'Add one more' }] };
      const next = kit.registry.add({
        id: t,
        orgId: pinned.orgId,
        version: 'v3',
        manifest,
        passJson: pinned.passJson,
        assets: { 'icon.png': ICON_PNG },
      });
      await persistTemplate(kit.fx, next, { registry: kit.registry, buildKey: 'value-test' });
      const s = await desk([t]);
      const pass = await kit.scanPass(t, { balance: 0 });
      const real = kit.env.DB;
      const hooked = beforeBatch(real, RACE_GATE_WRITE, (db) =>
        approveAppleRelease(kit, {
          db,
          templateId: t,
          version: change === 'other release' ? 'v3' : 'v2',
          mode: 'live',
        }),
      );
      Object.assign(kit.env, { DB: hooked.db });
      let res: Response;
      try {
        res = await act(s.headers, codeOf(pass), { actionId: 'add' });
      } finally {
        Object.assign(kit.env, { DB: real });
      }
      expect(hooked.fired()).toBe(true);
      if (change === 'identical republish') {
        expect((await out(res)).kind).toBe('ok');
        expect(await balanceOf(pass.id)).toBe(1);
        return;
      }
      expect(`${res.status} ${((await res.json()) as { code?: string }).code}`).toBe(
        '409 PASS_CONFLICT',
      );
      expect(await balanceOf(pass.id)).toBe(0);
      expect(
        await count("SELECT COUNT(*) AS n FROM scans WHERE pass_id = ? AND outcome = 'ok'", [
          pass.id,
        ]),
      ).toBe(0);
    },
  );
});
