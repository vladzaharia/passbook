import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser, persistTemplate } from '../../../../test/helpers/index.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { PLATFORM_NAME } from '../../../shared/email-from-name.ts';
import { first, run } from '../../platform/db.ts';
import { signInOidc } from '../auth/oidc-sign-in.ts';
import { resolveSession } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { passEmailOrgName } from '../delivery/email-from.ts';
import { getHolderPass } from '../holders/repo.ts';
import { approveCandidate, createCandidate, publishRelease } from '../templates/releases.ts';
import { readBranding, tenantPassJson } from './branding.ts';
import { createPassRow } from './create.ts';
import { finishCredentialTransfer, startCredentialTransfer } from './credential-transfer.ts';
import { issuerName } from './issuer.ts';
import { ICON_PNG, type Kit, setupKit } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';
import { getOrg } from './repo-read-issuance.ts';

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

describe('personal org journey', () => {
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

  /**
   * An admin signs in (the personal org is ensured), authors a template whose pass.json has its own issuer,
   * approves it alone in Live as the org's only member, and issues a pass: the owner's whole path.
   */
  async function journey() {
    const user = await makeUser(kit.fx);
    await run(kit.env.DB, "UPDATE users SET name = 'Pat Owner' WHERE id = ?", [user.id]);
    await run(
      kit.env.DB,
      `INSERT INTO auth_identities (provider, subject, user_id, email_claim, email_verified, groups, created_at)
       VALUES ('pocketid', ?, ?, ?, 1, '[]', 1)`,
      [`sub-${user.id}`, user.id, user.primaryEmail],
    );
    const signed = await signInOidc(
      kit.ctx,
      {
        sub: `sub-${user.id}`,
        email: user.primaryEmail,
        emailVerified: true,
        name: 'Pat Owner',
        groups: ['wallet_admins'],
      },
      { ipPrefix: null, userAgent: null },
    );
    const org = await first<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM orgs WHERE personal_user_id = ?',
      [user.id],
    );
    if (!org) throw new Error('No personal org');
    const auth = await resolveSession(kit.env, kit.ctx.clock, signed.session.cookieValue);
    if (!auth) throw new Error('No session');
    const base = kit.template;
    const resolved = kit.registry.add({
      id: `tpl-rain-${org.id.slice(-6)}`,
      orgId: org.id,
      manifest: base.manifest,
      passJson: {
        ...base.passJson,
        organizationName: 'Rain City Fit',
        logoText: 'Rain City',
        description: 'Gym pass',
      } as PassJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, resolved, { registry: kit.registry });
    const scope = { orgId: org.id, mode: 'live', provider: 'apple' } as const;
    const candidate = await createCandidate(kit.ctx, auth, resolved.id, {
      ...scope,
      version: resolved.version,
    });
    const approval = await approveCandidate(kit.ctx, auth, resolved.id, candidate.id, {
      ...scope,
      candidateHash: candidate.candidateHash,
      alone: true,
    });
    const release = await publishRelease(kit.ctx, auth, resolved.id, {
      ...scope,
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      expectedGeneration: 0,
    });
    const created = await createPassRow(jobCtxOf(kit), {
      orgId: org.id,
      templateId: resolved.id,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { memberName: 'Pat' },
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor: { type: 'user', id: user.id },
    });
    return { user, orgId: org.id, approval, pass: created };
  }

  it('lets a one-member org approve alone, release and issue a pass with the template issuer', async () => {
    const { orgId, approval, pass, user } = await journey();
    expect(approval.kind).toBe('sole');
    expect(await latest(pass.id)).toMatchObject({
      organizationName: 'Rain City Fit',
      logoText: 'Rain City',
      description: 'Gym pass',
    });
    const org = await getOrg(kit.env.DB, orgId);
    expect(org?.personal).toBe(true);
    expect(passEmailOrgName(org)).toBe(PLATFORM_NAME);
    // A reissue builds the same pass: it does not flip back to the owner's name.
    const { changed } = await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'admin',
      actor: { type: 'user', id: user.id },
    });
    expect(changed).toBe(false);
    expect(await latest(pass.id)).toMatchObject({ organizationName: 'Rain City Fit' });
  });

  it('keeps the template issuer through a credential transfer', async () => {
    const { pass } = await journey();
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
      organizationName: 'Rain City Fit',
      logoText: 'Rain City',
      description: 'Gym pass',
    });
  });
});
