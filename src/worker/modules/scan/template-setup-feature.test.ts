import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { all, run } from '../../platform/db.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';
import { eventTemplate } from './template-setup-test-fixtures.ts';

// POST /templates/{id}/scan-setup is gated behind the scanning feature (`scanning.devices`, 0 = off).
const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

const post = (id: string) =>
  fixture.call('POST', `/templates/${id}/scan-setup`, {
    orgId: fixture.kit.org.id,
    timeZone: 'UTC',
  });
const sessionRows = () =>
  all(fixture.kit.env.DB, 'SELECT id FROM scanning_sessions WHERE org_id = ?', [
    fixture.kit.org.id,
  ]);

describe('scan setup feature', () => {
  it('refuses with FEATURE_NOT_INCLUDED and writes nothing when scanning is off', async () => {
    const id = await eventTemplate(fixture.kit, 'Feature off');
    const db = fixture.kit.env.DB;
    const before = await sessionRows();
    await run(
      db,
      "INSERT INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'scanning.devices', '0', 1)",
      [fixture.kit.org.id],
    );
    const res = await post(id);
    await expectProblem(res, 403, 'FEATURE_NOT_INCLUDED');
    expect(((await res.json()) as { feature?: string }).feature).toBe('scanning.devices');
    expect(await sessionRows()).toEqual(before);
  });

  it('runs as before for a legacy org, and again once the feature is back on', async () => {
    const id = await eventTemplate(fixture.kit, 'Feature on');
    await run(fixture.kit.env.DB, 'DELETE FROM org_entitlement_overrides WHERE org_id = ?', [
      fixture.kit.org.id,
    ]);
    const res = await post(id);
    expect(res.status).toBe(200);
  });
});
