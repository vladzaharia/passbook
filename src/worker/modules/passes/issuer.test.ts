import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { run } from '../../platform/db.ts';
import { readBranding, tenantPassJson } from './branding.ts';
import { buildArtifact } from './builder.ts';
import { issuerName } from './issuer.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { getOrg, type PassOrg } from './repo-read-issuance.ts';
import { getPass } from './repo-read-pass.ts';

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

describe('personal org passes', () => {
  let kit: Kit;
  beforeAll(async () => {
    kit = await setupKit();
  });
  // A personal org has one member, so it cannot run the two-person release flow the kit needs.
  // The pass is made in the kit's org and rebuilt with the personal org's row, as every build path
  // (create, publish, transfer) does through `PassOrg`.
  const build = async (org: PassOrg) => {
    const made = await kit.pass({ memberName: 'Pat' });
    const pass = await getPass(kit.env.DB, made.id);
    if (!pass) throw new Error('Missing pass');
    return (
      await buildArtifact(kit.ctx, {
        orgId: pass.orgId,
        orgName: org.name,
        personal: org.personal,
        branding: org.branding,
        passId: pass.id,
        serial: pass.serial,
        authToken: pass.authToken,
        webServiceUrl: pass.webServiceUrl,
        identityId: pass.identityId,
        templateId: pass.templateId,
        templateVersion: pass.templateVersion,
        personalization: pass.personalization,
        status: pass.status,
      })
    ).passJson;
  };

  it('reads the flag from the org row and keeps the template issuer only for a personal org', async () => {
    const owner = await makeUser(kit.fx);
    const orgId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      'INSERT INTO orgs (id, slug, name, created_at, updated_at, personal_user_id) VALUES (?, ?, ?, 1, 1, ?)',
      [orgId, `personal-${orgId.slice(-6)}`, 'Pat Owner', owner.id],
    );
    const personal = await getOrg(kit.env.DB, orgId);
    const normal = await getOrg(kit.env.DB, kit.org.id);
    if (!personal || !normal) throw new Error('Missing org');
    expect([personal.personal, normal.personal]).toEqual([true, false]);
    expect(await build(normal)).toMatchObject({
      organizationName: kit.org.name,
      description: expect.stringContaining(kit.org.name),
    });
    // Built again, as a reissue or transfer does, it stays the template's own.
    for (let rebuilt = 0; rebuilt < 2; rebuilt++)
      expect(await build(personal)).toMatchObject({
        organizationName: 'placeholder',
        description: 'Test pass',
      });
  });
});
