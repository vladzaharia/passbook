import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { all } from '../../platform/db.ts';
import { type Api, auditOf, BASE, setupApi, wipe } from './api-test-fixtures.ts';
import { type Net, stubNet } from './deliver-test-fixtures.ts';
import * as repo from './repo-replay.ts';

// The count and the missing-seq reads are stubbed so the caps need not be filled with 10,001 rows.
vi.mock('./repo-replay.ts', async (orig) => {
  const m = await orig<typeof import('./repo-replay.ts')>();
  return {
    ...m,
    countReplayable: vi.fn(m.countReplayable),
    missingSeqs: vi.fn(m.missingSeqs),
    backfillDeliveries: vi.fn(m.backfillDeliveries),
  };
});

let api: Api;
let net: Net;
beforeAll(async () => {
  api = await setupApi();
  net = stubNet();
});
afterAll(() => net.restore());
beforeEach(async () => {
  await wipe(api.rig);
  api.resetLimits();
  const real = await vi.importActual<typeof import('./repo-replay.ts')>('./repo-replay.ts');
  vi.mocked(repo.countReplayable).mockImplementation(real.countReplayable);
  vi.mocked(repo.missingSeqs).mockImplementation(real.missingSeqs);
  vi.mocked(repo.backfillDeliveries).mockImplementation(real.backfillDeliveries);
});

async function scene(passes: number) {
  const orgId = await api.otherOrg();
  const admin = await api.member(['org_admin'], { orgId });
  for (let i = 0; i < passes; i++) await api.rig.kit.pass({ orgId });
  const made = await api.call(
    'POST',
    BASE,
    { orgId, url: 'https://hooks.example.com/c/abcd', eventTypes: ['pass.issued'] },
    admin,
  );
  const id = made.json.endpoint.id as string;
  return {
    orgId,
    admin,
    id,
    replay: (body: object) => api.call('POST', `${BASE}/${id}/replay`, body, admin),
  };
}

describe('REPLAY_TOO_LARGE', () => {
  it('refuses more than 10,000 existing deliveries, writes nothing and keeps the minute free', async () => {
    const s = await scene(1);
    vi.mocked(repo.countReplayable).mockResolvedValue(10_001);
    await expectProblem(
      await s.replay({ from: 0, to: 4e12, include: 'all' }),
      422,
      'REPLAY_TOO_LARGE',
    );
    expect(await auditOf(api.rig.db, 'webhook.replay')).toEqual([]);
    vi.mocked(repo.countReplayable).mockResolvedValue(10_000);
    // The refused call did not spend the per-minute replay.
    expect((await s.replay({ from: 0, to: 4e12 })).status).toBe(200);
  });

  it('refuses a backfill that overflows 10,000, and asks for one row more than the cap', async () => {
    const s = await scene(1);
    vi.mocked(repo.missingSeqs).mockResolvedValue(Array.from({ length: 10_001 }, (_, i) => i + 1));
    await expectProblem(
      await s.replay({ from: 0, to: 4e12, missing: true }),
      422,
      'REPLAY_TOO_LARGE',
    );
    expect(vi.mocked(repo.missingSeqs).mock.calls[0]?.[3]).toMatchObject({ limit: 10_001 });
    vi.mocked(repo.countReplayable).mockResolvedValue(1);
    vi.mocked(repo.missingSeqs).mockResolvedValue(Array.from({ length: 10_000 }, (_, i) => i + 1));
    api.resetLimits();
    await expectProblem(
      await s.replay({ from: 0, to: 4e12, missing: true }),
      422,
      'REPLAY_TOO_LARGE',
    );
  });
});

describe('partial backfill', () => {
  it('returns what the committed chunks queued when a later chunk fails', async () => {
    const s = await scene(3);
    const real = await vi.importActual<typeof import('./repo-replay.ts')>('./repo-replay.ts');
    const seqs = (
      await all<{ seq: number }>(
        api.rig.db,
        'SELECT seq FROM event_feed WHERE org_id = ? ORDER BY seq',
        [s.orgId],
      )
    ).map((r) => r.seq);
    // 3 real events, padded to 501 so the backfill takes two grants (500 events each at most).
    const padded = [...seqs, ...Array.from({ length: 498 }, (_, i) => 9_000_000 + i)];
    vi.mocked(repo.missingSeqs).mockResolvedValue(padded);
    let calls = 0;
    vi.mocked(repo.backfillDeliveries).mockImplementation((g, endpointId, list) => {
      calls++;
      // The 26th statement is the first of the second grant: make that grant abort.
      if (calls === 26)
        g.update('webhook_endpoints', {
          where: { id: 'gone' },
          set: { updated_at: 1 },
          require: 'one',
        });
      return real.backfillDeliveries(g, endpointId, list);
    });
    const res = await s.replay({ from: 0, to: 4e12, missing: true });
    expect(calls).toBeGreaterThan(25);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ queued: 3 });
    const rows = await all<{ n: number }>(
      api.rig.db,
      'SELECT count(*) AS n FROM webhook_deliveries WHERE endpoint_id = ?',
      [s.id],
    );
    expect(rows[0]?.n).toBe(3);
    expect(await auditOf(api.rig.db, 'webhook.replay')).toHaveLength(1);
  });

  it('fails the call when the first chunk fails: nothing was committed', async () => {
    const s = await scene(2);
    const real = await vi.importActual<typeof import('./repo-replay.ts')>('./repo-replay.ts');
    vi.mocked(repo.backfillDeliveries).mockImplementation((g, endpointId, list) => {
      g.update('webhook_endpoints', {
        where: { id: 'gone' },
        set: { updated_at: 1 },
        require: 'one',
      });
      return real.backfillDeliveries(g, endpointId, list);
    });
    expect((await s.replay({ from: 0, to: 4e12, missing: true })).status).toBeGreaterThanOrEqual(
      400,
    );
    expect(await auditOf(api.rig.db, 'webhook.replay')).toEqual([]);
  });
});
