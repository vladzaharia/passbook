import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { first, run as sql } from '../../platform/db.ts';
import { revokeOrgCredential } from './credential-service.ts';
import { readGoogleSecret } from './credential-system-save.ts';
import { setManagedDeps } from './google-managed-deps.ts';
import { type ManagedKit, managedKit } from './google-managed-kit-fixtures.ts';
import { SA_EMAIL } from './google-managed-test-fixtures.ts';
import { latestManagedRun, runManagedIssuer, startManagedIssuer } from './issuer-provision.ts';
import { activeOrgGoogle } from './repo-google-managed.ts';
import { sharedIssuerInfo, shareGoogleIssuer } from './shared-issuer.ts';

let m: ManagedKit;
beforeAll(async () => {
  m = await managedKit();
}, 30_000);
afterAll(() => setManagedDeps());

/** An org with a live admin whose address is verified, and who owns `issuerId` in Google. */
async function ownerOf(name: string, issuerId?: string) {
  const org = await m.org(name);
  const member = await m.k.member(org.id, 'live');
  await sql(
    m.k.env.DB,
    "INSERT OR IGNORE INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, 'admin', ?)",
    [member.user.primaryEmail, member.user.id, Date.now()],
  );
  if (issuerId) {
    m.stub.issuers.set(issuerId, `${name} issuer`);
    m.stub.owners.set(issuerId, [member.user.primaryEmail.toUpperCase()]);
  }
  return { org, ...member };
}

const release = async (orgId: string, auth: Parameters<typeof revokeOrgCredential>[1]) => {
  const row = await activeOrgGoogle(m.k.env.DB, orgId, 'live');
  if (!row) throw new Error('no credential');
  await revokeOrgCredential(m.ctx, auth, orgId, row.id, { expectedRevision: row.revision });
};

describe('shared Google issuer (Own)', () => {
  it("proves access and ownership, then keeps PassBook's key on the org credential", async () => {
    const { org, auth } = await ownerOf('Own Org', '8001');
    expect(await sharedIssuerInfo(m.ctx, auth, org.id)).toEqual({ serviceAccountEmail: SA_EMAIL });

    const done = await shareGoogleIssuer(m.ctx, auth, org.id, '8001');
    expect(done.serviceAccountEmail).toBe(SA_EMAIL);
    expect(done.credential).toMatchObject({ provenance: 'own', scope: 'org', orgId: org.id });
    expect(m.stub.calls).toContain('GET walletobjects.googleapis.com/walletobjects/v1/issuer/8001');
    expect(m.stub.calls).toContain(
      'GET walletobjects.googleapis.com/walletobjects/v1/permissions/8001',
    );
    const row = await activeOrgGoogle(m.k.env.DB, org.id, 'live');
    expect(row).toMatchObject({ provenance: 'own', signer_ref: m.platform.id });
    const own = await readGoogleSecret(m.ctx, row?.id ?? '');
    expect(own.credentials.issuerId).toBe('8001');
    expect(own.credentials.privateKeyPem).toBe(
      (await readGoogleSecret(m.ctx, m.platform.id)).credentials.privateKeyPem,
    );
    expect(JSON.stringify(done)).not.toContain('PRIVATE KEY');
    const again = await shareGoogleIssuer(m.ctx, auth, org.id, '8001');
    expect(again.credential.revision).toBe(done.credential.revision);
  });

  it('refuses an issuer PassBook cannot act for, naming the address to add', async () => {
    const { org, auth } = await ownerOf('Refused Org');
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

  it('refuses an issuer whose owner is not a verified admin of the org', async () => {
    const { org, auth } = await ownerOf('Not Owner');
    m.stub.issuers.set('8010', 'Someone else');
    m.stub.owners.set('8010', ['somebody@elsewhere.example']);
    await expect(shareGoogleIssuer(m.ctx, auth, org.id, '8010')).rejects.toMatchObject({
      code: 'GOOGLE_ISSUER_NOT_OWNED',
    });
    // An owner that is the admin's address but not verified does not count.
    const unverified = await m.org('Unverified');
    const member = await m.k.member(unverified.id, 'live');
    await sql(m.k.env.DB, 'DELETE FROM user_emails WHERE user_id = ?', [member.user.id]);
    m.stub.owners.set('8010', [member.user.primaryEmail]);
    await expect(
      shareGoogleIssuer(m.ctx, member.auth, unverified.id, '8010'),
    ).rejects.toMatchObject({
      code: 'GOOGLE_ISSUER_NOT_OWNED',
    });
    expect(await activeOrgGoogle(m.k.env.DB, org.id, 'live')).toBeNull();
  });

  it('keeps orgs apart: no sharing for another org, none by id, none by renaming, none after release without proof', async () => {
    const a = await ownerOf('Org A', '8003');
    const b = await ownerOf('Org B');
    await expect(shareGoogleIssuer(m.ctx, b.auth, a.org.id, '8003')).rejects.toMatchObject({
      status: 403,
    });
    await shareGoogleIssuer(m.ctx, a.auth, a.org.id, '8003');
    // By id: B is an owner of nothing, and the claim holds.
    await expect(shareGoogleIssuer(m.ctx, b.auth, b.org.id, '8003')).rejects.toMatchObject({
      code: 'GOOGLE_ISSUER_NOT_OWNED',
    });
    // B names itself as A and even becomes an owner in Google: A still holds the issuer.
    m.stub.owners.set('8003', [a.user.primaryEmail, b.user.primaryEmail]);
    await sql(m.k.env.DB, 'UPDATE orgs SET name = ? WHERE id = ?', ['Org A', b.org.id]);
    await expect(shareGoogleIssuer(m.ctx, b.auth, b.org.id, '8003')).rejects.toMatchObject({
      code: 'WALLET_ISSUER_CLAIMED',
    });
    expect(await activeOrgGoogle(m.k.env.DB, b.org.id, 'live')).toBeNull();

    // After A releases it, B still needs the proof: without it, no.
    m.stub.owners.set('8003', [a.user.primaryEmail]);
    await release(a.org.id, a.auth);
    await expect(shareGoogleIssuer(m.ctx, b.auth, b.org.id, '8003')).rejects.toMatchObject({
      code: 'GOOGLE_ISSUER_NOT_OWNED',
    });
    // With the proof B may take over an issuer A owned itself.
    m.stub.owners.set('8003', [b.user.primaryEmail]);
    await shareGoogleIssuer(m.ctx, b.auth, b.org.id, '8003');
    const claim = await first<{ org_id: string }>(
      m.k.env.DB,
      'SELECT org_id FROM wallet_google_issuers WHERE issuer_id = ?',
      ['8003'],
    );
    expect(claim?.org_id).toBe(b.org.id);
  });

  it("never hands over an issuer PassBook made, released or not, and never PassBook's own", async () => {
    const a = await ownerOf('Made Org');
    const b = await ownerOf('Taker Org');
    const { run } = await startManagedIssuer(m.ctx, { orgId: a.org.id, createdBy: null });
    await runManagedIssuer(m.ctx, run.runId);
    const made = (await latestManagedRun(m.ctx, a.org.id))?.issuerId ?? '';
    m.stub.owners.set(made, [b.user.primaryEmail]);
    await expect(shareGoogleIssuer(m.ctx, b.auth, b.org.id, made)).rejects.toMatchObject({
      code: 'WALLET_ISSUER_CLAIMED',
    });
    await release(a.org.id, a.auth);
    await expect(shareGoogleIssuer(m.ctx, b.auth, b.org.id, made)).rejects.toMatchObject({
      code: 'WALLET_ISSUER_CLAIMED',
    });
    m.stub.owners.set('1000000000000001', [b.user.primaryEmail]);
    await expect(
      shareGoogleIssuer(m.ctx, b.auth, b.org.id, '1000000000000001'),
    ).rejects.toMatchObject({ code: 'WALLET_ISSUER_CLAIMED' });
  });
});
