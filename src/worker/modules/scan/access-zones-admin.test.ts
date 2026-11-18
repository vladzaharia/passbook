import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import type { ScanZone } from '../../../shared/contracts/scan-access.ts';
import { first, run } from '../../platform/db.ts';
import { ACCESS } from './access-test-fixtures.ts';
import { ACCESS_GATE } from './repo-access.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';
import { grantScanMembership } from './test-kit.ts';

const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

const zone = async (body: Record<string, unknown>): Promise<ScanZone> => {
  const res = await fixture.call('POST', '/scan-zones', { orgId: fixture.kit.org.id, ...body });
  expect(res.status).toBe(201);
  return (await res.json()) as ScanZone;
};

describe('zones: plans', () => {
  it('lists the plans that open each zone, through the key, a parent key or every zone', async () => {
    const { kit } = fixture;
    const club = await zone({ key: 'club', name: 'Club' });
    const studio = await zone({ key: 'studio', name: 'Studio', parentId: club.id });
    const pool = await zone({ key: 'pool', name: 'Pool' });
    await kit.scanTemplate('Gym card', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      access: {
        ...ACCESS,
        plans: [
          { id: 'all', label: 'Everything', kind: 'always', zones: [{ zone: '*' }] },
          { id: 'club_only', label: 'Club only', kind: 'always', zones: [{ zone: 'club' }] },
          { id: 'laps', label: 'Laps', kind: 'always', zones: [{ zone: 'pool' }] },
          { id: 'by_input', label: 'Home', kind: 'always', zones: [{ zone: { input: 'home' } }] },
        ],
      },
    });
    const res = await fixture.call('GET', `/scan-zones?orgId=${kit.org.id}`);
    const items = ((await res.json()) as { items: ScanZone[] }).items;
    const labels = (id: string) =>
      items
        .find((z) => z.id === id)
        ?.plans.map((p) => p.label)
        .sort();
    expect(labels(club.id)).toEqual(['Club only', 'Everything']);
    expect(labels(studio.id)).toEqual(['Club only', 'Everything']);
    expect(labels(pool.id)).toEqual(['Everything', 'Laps']);
    expect(items.find((z) => z.id === pool.id)?.plans[0]).toMatchObject({
      templateName: 'Gym card',
    });
  });
});

describe('visits: reset', () => {
  async function seed() {
    const { kit } = fixture;
    const tpl = await kit.scanTemplate('Guest card', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      access: ACCESS,
    });
    const pass = await kit.scanPass(tpl, { plan: 'guest' });
    const now = kit.clock.now();
    await run(
      kit.env.DB,
      `INSERT INTO scan_gates (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
       VALUES (?, ?, ?, ?, 'live', ?, 'check_in', 'in', 2, ?, ?, 'x')`,
      [pass.id, ACCESS_GATE, ACCESS_GATE, kit.org.id, tpl, now, now],
    );
    return pass;
  }
  const gates = (passId: string) =>
    first<{ n: number }>(
      fixture.kit.env.DB,
      'SELECT count(*) AS n FROM scan_gates WHERE pass_id = ?',
      [passId],
    );

  it('deletes the gate row and audits it', async () => {
    const pass = await seed();
    const res = await fixture.call('POST', `/scan-zones/visits/${pass.id}/reset`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ passId: pass.id, visits: 0 });
    expect(await gates(pass.id)).toEqual({ n: 0 });
    expect(
      await first(
        fixture.kit.env.DB,
        "SELECT count(*) AS n FROM audit_log WHERE action = 'pass.access_visits_reset' AND target_id = ?",
        [pass.id],
      ),
    ).toEqual({ n: 1 });
  });

  it('refuses a person without scanning:manage, a foreign pass and an unknown pass', async () => {
    const { kit, fake } = fixture;
    const pass = await seed();
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id, ['pass_operator']);
    const operator = fake.session({ userId: user.id, roles: ['user'] });
    const denied = await fixture.call(
      'POST',
      `/scan-zones/visits/${pass.id}/reset`,
      undefined,
      operator,
    );
    expect(denied.status).toBe(403);
    expect(await gates(pass.id)).toEqual({ n: 1 });

    const other = await makeOrg(kit.fx);
    const theirs = await kit.scanTemplate(
      'Theirs',
      { actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }], access: ACCESS },
      { orgId: other.id },
    );
    const foreign = await kit.scanPass(theirs, { plan: 'gold' }, { orgId: other.id });
    expect((await fixture.call('POST', `/scan-zones/visits/${foreign.id}/reset`)).status).toBe(404);
    expect((await fixture.call('POST', `/scan-zones/visits/${kit.fx.ids.id()}/reset`)).status).toBe(
      404,
    );
  });
});
