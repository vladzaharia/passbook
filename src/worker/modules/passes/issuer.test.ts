import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { readBranding, tenantPassJson } from './branding.ts';
import { finishCredentialTransfer, startCredentialTransfer } from './credential-transfer.ts';
import { issuerName } from './issuer.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';

const base = {
  organizationName: 'Rain City Fit',
  logoText: 'Rain City',
  description: 'Gym pass',
} as unknown as PassJson;
const branding = readBranding({ passColors: { background: '#112233' } });

describe('issuerName', () => {
  it('keeps the template issuer for a personal org and the org name for any other', () => {
    expect(issuerName('Ada', true, base)).toBe('Rain City Fit');
    expect(issuerName('Acme', false, base)).toBe('Acme');
  });
  it('ignores a template name that is not a plain short line', () => {
    for (const bad of ['Rain\nCity', 'Rain\u202ECity', 'x'.repeat(65)])
      expect(issuerName('Ada', true, { organizationName: bad })).toBe('Ada');
  });
  it('falls back to the org name when the template has none or a blank one', () => {
    expect(issuerName('Ada', true, {})).toBe('Ada');
    expect(issuerName('Ada', true, { organizationName: '  ' })).toBe('Ada');
    expect(issuerName('Ada', true, { organizationName: 7 })).toBe('Ada');
  });
});

describe('tenantPassJson', () => {
  it('leaves logoText and description alone for a personal org, but still applies its colours', () => {
    const pass = tenantPassJson(base, 'Ada', branding, true);
    expect(pass).toMatchObject({
      logoText: 'Rain City',
      description: 'Gym pass',
      backgroundColor: '#112233',
    });
  });
  it('substitutes the org name for any other org, as before', () => {
    const pass = tenantPassJson(base, 'Acme', branding);
    expect(pass).toMatchObject({ logoText: 'Acme', description: 'Acme gym pass' });
  });
});

/** The release fixture adds its own members; lift the one-member triggers while it does, then restore them. */
async function withFixtureMembers<T>(kit: Kit, setup: () => Promise<T>): Promise<T> {
  const db = kit.env.DB;
  const triggers = await all<{ name: string; sql: string }>(
    db,
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_personal_single'",
  );
  for (const t of triggers) await run(db, `DROP TRIGGER ${t.name}`);
  try {
    return await setup();
  } finally {
    for (const t of triggers) await run(db, t.sql);
  }
}

describe('personal org passes', () => {
  let kit: Kit;
  beforeAll(async () => {
    kit = await setupKit();
  });
  const latest = async (passId: string) =>
    JSON.parse(
      (
        await first<{ pass_json: string }>(
          kit.env.DB,
          'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
          [passId],
        )
      )?.pass_json ?? '{}',
    ) as PassJson;

  it('prints the org name on a normal org, the template name on a personal one, and keeps it on reissue', async () => {
    const normal = await kit.pass({ memberName: 'Normal' });
    expect(await latest(normal.id)).toMatchObject({
      organizationName: kit.org.name,
      description: expect.stringContaining(kit.org.name),
    });
    const owner = await makeUser(kit.fx);
    const orgId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      'INSERT INTO orgs (id, slug, name, created_at, updated_at, personal_user_id) VALUES (?, ?, ?, 1, 1, ?)',
      [orgId, `personal-${orgId.slice(-6)}`, 'Pat Owner', owner.id],
    );
    await run(
      kit.env.DB,
      "INSERT INTO org_entitlements (org_id, preset, updated_at) VALUES (?, 'legacy', 1)",
      [orgId],
    );
    const fresh = await withFixtureMembers(kit, () => kit.pass({ memberName: 'Fresh', orgId }));
    expect(await latest(fresh.id)).toMatchObject({
      organizationName: 'placeholder',
      description: 'Test pass',
    });
    // A reissue does not flip it back to the owner's name.
    const { changed } = await publishPass(jobCtxOf(kit), {
      passId: fresh.id,
      cause: 'admin',
      actor: { type: 'user', id: owner.id },
    });
    expect(changed).toBe(false);
    const reissued = await latest(fresh.id);
    expect(reissued.organizationName).toBe('placeholder');
    expect(reissued.description).toBe('Test pass');
  });

  it('keeps the template issuer through a credential transfer', async () => {
    const owner = await makeUser(kit.fx);
    const orgId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      'INSERT INTO orgs (id, slug, name, created_at, updated_at, personal_user_id) VALUES (?, ?, ?, 1, 1, ?)',
      [orgId, `personal-${orgId.slice(-6)}`, 'Pat Owner', owner.id],
    );
    await run(
      kit.env.DB,
      "INSERT INTO org_entitlements (org_id, preset, updated_at) VALUES (?, 'legacy', 1)",
      [orgId],
    );
    const pass = await withFixtureMembers(kit, () => kit.pass({ memberName: 'Moving', orgId }));
    const expected = await getHolderPass(kit.env.DB, pass.id, null);
    if (!expected) throw new Error('Missing holder pass');
    const started = await startCredentialTransfer(
      jobCtxOf(kit),
      { type: 'system', id: null },
      pass.id,
      { holderEmail: 'next@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected },
    );
    await finishCredentialTransfer(jobCtxOf(kit), started.transferId);
    expect(await latest(pass.id)).toMatchObject({
      organizationName: 'placeholder',
      description: 'Test pass',
    });
  });
});
