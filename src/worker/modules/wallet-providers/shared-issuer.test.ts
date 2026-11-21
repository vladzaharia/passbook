import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { all } from '../../platform/db.ts';
import { readGoogleSecret } from './credential-system-save.ts';
import { setManagedDeps } from './google-managed-deps.ts';
import { type ManagedKit, managedKit } from './google-managed-kit-fixtures.ts';
import { SA_EMAIL } from './google-managed-test-fixtures.ts';
import { activeOrgGoogle } from './repo-google-managed.ts';
import { sharedIssuerInfo, shareGoogleIssuer } from './shared-issuer.ts';

let m: ManagedKit;
beforeAll(async () => {
  m = await managedKit();
}, 30_000);
afterAll(() => setManagedDeps());

describe('shared Google issuer (Own)', () => {
  it("verifies PassBook's access with issuer.get and keeps PassBook's key on the org credential", async () => {
    const org = await m.org('Own Org');
    const { auth } = await m.k.member(org.id, 'live');
    expect(await sharedIssuerInfo(m.ctx, auth, org.id)).toEqual({ serviceAccountEmail: SA_EMAIL });
    m.stub.issuers.set('8001', 'Own Org issuer');

    const done = await shareGoogleIssuer(m.ctx, auth, org.id, '8001');
    expect(done.serviceAccountEmail).toBe(SA_EMAIL);
    expect(done.credential).toMatchObject({ provenance: 'own', scope: 'org', orgId: org.id });
    expect(m.stub.calls).toContain('GET walletobjects.googleapis.com/walletobjects/v1/issuer/8001');
    const row = await activeOrgGoogle(m.k.env.DB, org.id, 'live');
    expect(row).toMatchObject({ provenance: 'own', signer_ref: m.platform.id });
    const own = await readGoogleSecret(m.ctx, row?.id ?? '');
    expect(own.credentials.issuerId).toBe('8001');
    expect(own.credentials.privateKeyPem).toBe(
      (await readGoogleSecret(m.ctx, m.platform.id)).credentials.privateKeyPem,
    );
    expect(JSON.stringify(done)).not.toContain('PRIVATE KEY');
    // Again with the same issuer: nothing new is written.
    const again = await shareGoogleIssuer(m.ctx, auth, org.id, '8001');
    expect(again.credential.revision).toBe(done.credential.revision);
  });

  it('refuses an issuer PassBook cannot act for, naming the address to add', async () => {
    const org = await m.org('Refused Org');
    const { auth } = await m.k.member(org.id, 'live');
    await expect(shareGoogleIssuer(m.ctx, auth, org.id, '8002')).rejects.toMatchObject({
      status: 422,
      code: 'GOOGLE_ISSUER_NOT_SHARED',
      message: expect.stringContaining(SA_EMAIL),
    });
    expect(await activeOrgGoogle(m.k.env.DB, org.id, 'live')).toBeNull();
    await expect(shareGoogleIssuer(m.ctx, auth, org.id, 'abc')).rejects.toMatchObject({
      status: 422,
    });
  });

  it('keeps orgs apart: no sharing for another org, none of an issuer another org holds', async () => {
    const a = await m.org('Org A');
    const b = await m.org('Org B');
    const memberA = await m.k.member(a.id, 'live');
    const memberB = await m.k.member(b.id, 'live');
    m.stub.issuers.set('8003', 'Shared');
    await expect(shareGoogleIssuer(m.ctx, memberB.auth, a.id, '8003')).rejects.toMatchObject({
      status: 403,
    });
    await shareGoogleIssuer(m.ctx, memberA.auth, a.id, '8003');
    await expect(shareGoogleIssuer(m.ctx, memberB.auth, b.id, '8003')).rejects.toMatchObject({
      code: 'WALLET_ISSUER_CLAIMED',
    });
    expect(await activeOrgGoogle(m.k.env.DB, b.id, 'live')).toBeNull();
    const rows = await all<{ org_id: string }>(
      m.k.env.DB,
      "SELECT org_id FROM wallet_credentials WHERE provider = 'google' AND identity_hint = '8003'",
    );
    expect(rows.map((r) => r.org_id)).toEqual([a.id]);
  });
});
