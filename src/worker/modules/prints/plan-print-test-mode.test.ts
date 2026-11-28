import { describe, expect, it } from 'vitest';
import { linkToken } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { ruleKit } from '../message-rules/test-kit.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { clearSettingsCache } from '../settings/service.ts';

const ORIGIN = 'https://wallet.test';
const test = { 'x-passbook-mode': 'test', 'content-type': 'application/json' };

async function setup() {
  const kit = await ruleKit();
  await run(
    kit.env.DB,
    "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'print.enabled', 'true', 'test', 1)",
  );
  clearSettingsCache(kit.env.DB);
  await run(
    kit.env.DB,
    `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
     VALUES (?, 'print', '0', 1)`,
    [kit.org.id],
  );
  const release = await approveAppleRelease(kit, {
    templateId: kit.dated.id,
    version: 'v1',
    orgId: kit.org.id,
    mode: 'test',
  });
  const mkPass = async (name: string) => {
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: kit.dated.id,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { memberName: name },
      holderEmail: null,
      source: 'manual',
      mode: 'test',
      execution: { kind: 'system' },
      actor: { type: 'system', id: null },
    });
    const res = await kit.api(`/passes/${pass.id}/channels`, {
      method: 'PUT',
      headers: { ...kit.auth.admin(), ...test },
      body: JSON.stringify({ channels: { paper: 'on' } }),
    });
    expect(res.status).toBe(200);
    return pass;
  };
  return { kit, mkPass };
}

describe('print in Test on a plan without print', () => {
  it('prints from the staff route, a holder link and a bulk job', async () => {
    const { kit, mkPass } = await setup();
    const staff = await mkPass('Staff Holder');
    const res = await kit.api(`/passes/${staff.id}/prints`, {
      method: 'POST',
      headers: { ...kit.auth.admin(), ...test },
    });
    expect(res.status).toBe(200);

    const held = await mkPass('Link Holder');
    const token = await linkToken(kit.env, held as never);
    const link = await kit.app.request(
      `${ORIGIN}/p/${token}/print`,
      { method: 'POST', headers: { origin: ORIGIN } },
      kit.env,
    );
    expect(link.status).toBe(200);

    const bulk = await mkPass('Bulk Holder');
    const started = await kit.api('/passes/bulk-print', {
      method: 'POST',
      headers: { ...kit.auth.admin(), ...test },
      body: JSON.stringify({ ids: [bulk.id], orgId: kit.org.id }),
    });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ count: 1, skipped: [] });
  });
});
