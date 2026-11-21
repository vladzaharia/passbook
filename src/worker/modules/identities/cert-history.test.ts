import { describe, expect, it } from 'vitest';
import { all, first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { createFakeWwdr, issueFromCsr } from './cert-fixtures.ts';
import {
  abandonPendingCertificate,
  activatePendingCertificate,
  adoptByPubkey,
  beginPendingCertificate,
  findPendingCertificate,
} from './cert-history.ts';
import { certPubkeySha256 } from './csr.ts';
import { clearIdentityKeyCache, loadIdentityKey } from './db-resolver.ts';
import { getIdentityRow, insertIdentity } from './repo.ts';
import { listCertificateRows } from './repo-certificates.ts';

const KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
let n = 0;

const byId = (rows: { id: string; state: string }[]) =>
  Object.fromEntries(rows.map((r) => [r.id, r.state]));
const TEAM = '48H7CLBV8Y';

async function setup() {
  n += 1;
  const PTI = `pass.mobile.passbook.acme${n}`;
  const ID = `ident-${n}`;
  const OLD = `cred-old-${n}`;
  const kit: Kit = await setupKit({ clockStart: Date.UTC(2026, 10, 20) });
  const ca = await createFakeWwdr(kit.clock.now());
  const env = { ...kit.env, KEK_V1, SIGNER_PLATFORM_INTERMEDIATE: ca.pem };
  const ctx = { ...jobCtxOf(kit), env };
  const now = kit.clock.now();
  await insertIdentity(env.DB, {
    credential: {
      id: OLD,
      orgId: kit.org.id,
      kekVersion: 1,
      iv: new Uint8Array(12),
      wrappedDek: new Uint8Array(60),
      ciphertext: new Uint8Array(16),
      fingerprint: 'old',
    },
    identity: {
      id: ID,
      orgId: kit.org.id,
      label: 'Acme',
      passTypeIdentifier: PTI,
      teamIdentifier: TEAM,
      certPem: 'old-pem',
      certSha256: 'old',
      notBefore: now - 1000,
      notAfter: now + 1000,
      nfcEnabled: false,
    },
    now,
  });
  // The identities trigger records the insert as the active history row.
  const OLD_CERT = (await listCertificateRows(env.DB, ID))[0]?.id ?? '';
  const row = async () => {
    const r = await getIdentityRow(env.DB, ID);
    if (!r) throw new Error('missing identity');
    return r;
  };
  return { kit, ca, ctx, row, PTI, ID, OLD, OLD_CERT };
}

describe('certificate history', () => {
  it('begins pending with a sealed key, then activates and supersedes the old row', async () => {
    const { kit, ca, ctx, row, PTI, ID, OLD, OLD_CERT } = await setup();
    const pending = await beginPendingCertificate(ctx, await row());
    let rows = await listCertificateRows(ctx.env.DB, ID);
    expect(byId(rows)).toEqual({
      [OLD_CERT]: 'active',
      [pending.certId]: 'pending',
    });
    const der = await issueFromCsr(
      pending.csrDer,
      ca,
      { passTypeIdentifier: PTI, teamIdentifier: TEAM },
      { now: kit.clock.now() },
    );

    const out = await activatePendingCertificate(ctx, await row(), pending.certId, {
      certificateDer: der,
      ascCertificateId: 'asc-1',
    });
    rows = await listCertificateRows(ctx.env.DB, ID);
    expect(byId(rows)).toEqual({
      [OLD_CERT]: 'superseded',
      [pending.certId]: 'active',
    });
    expect(rows.find((r) => r.id === pending.certId)).toMatchObject({
      asc_certificate_id: 'asc-1',
      cert_sha256: out.sha256,
    });
    expect(rows.find((r) => r.id === OLD_CERT)?.ended_at).toBe(kit.clock.now());

    const identity = await row();
    expect(identity).toMatchObject({ cert_sha256: out.sha256, not_after: out.notAfter });
    expect(identity.credential_id).toBe(rows.find((r) => r.id === pending.certId)?.credential_id);
    expect(
      await first(ctx.env.DB, 'SELECT 1 AS x FROM credentials WHERE id = ?', [OLD]),
    ).toBeNull();
    clearIdentityKeyCache();
    expect(await loadIdentityKey(ctx.env, identity)).toContain('BEGIN PRIVATE KEY');
  });

  it('activating twice with the same certificate is a no-op', async () => {
    const { kit, ca, ctx, row, PTI, ID } = await setup();
    const pending = await beginPendingCertificate(ctx, await row());
    const der = await issueFromCsr(
      pending.csrDer,
      ca,
      { passTypeIdentifier: PTI, teamIdentifier: TEAM },
      { now: kit.clock.now() },
    );
    const first = await activatePendingCertificate(ctx, await row(), pending.certId, {
      certificateDer: der,
      ascCertificateId: null,
    });
    const again = await activatePendingCertificate(ctx, await row(), pending.certId, {
      certificateDer: der,
      ascCertificateId: null,
    });
    expect(again.sha256).toBe(first.sha256);
    expect(
      (await listCertificateRows(ctx.env.DB, ID)).filter((r) => r.state === 'active'),
    ).toHaveLength(1);
  });

  it('finds the pending row by public-key hash and adopts the matching certificate on retry', async () => {
    const { kit, ca, ctx, row, PTI, ID } = await setup();
    const pending = await beginPendingCertificate(ctx, await row());
    expect((await findPendingCertificate(ctx, ID, pending.pubkeySha256))?.id).toBe(pending.certId);
    expect(await findPendingCertificate(ctx, ID, 'nope')).toBeNull();

    const other = await beginPendingCertificate(ctx, await row());
    const subject = { passTypeIdentifier: PTI, teamIdentifier: TEAM };
    const listing = [
      { ascId: 'a', der: await issueFromCsr(other.csrDer, ca, subject, { now: kit.clock.now() }) },
      {
        ascId: 'b',
        der: await issueFromCsr(pending.csrDer, ca, subject, { now: kit.clock.now() }),
      },
      { ascId: 'c', der: null },
    ];
    const adopted = await adoptByPubkey(listing, pending.pubkeySha256);
    expect(adopted?.ascId).toBe('b');
    expect(await certPubkeySha256(adopted?.der ?? new Uint8Array())).toBe(pending.pubkeySha256);
    expect(await adoptByPubkey(listing, 'nope')).toBeNull();
  });

  it('refuses a certificate for the wrong pass type and leaves everything as it was', async () => {
    const { kit, ca, ctx, row, ID, OLD_CERT } = await setup();
    const pending = await beginPendingCertificate(ctx, await row());
    const der = await issueFromCsr(
      pending.csrDer,
      ca,
      { passTypeIdentifier: 'pass.mobile.passbook.other', teamIdentifier: TEAM },
      { now: kit.clock.now() },
    );
    await expect(
      activatePendingCertificate(ctx, await row(), pending.certId, {
        certificateDer: der,
        ascCertificateId: null,
      }),
    ).rejects.toMatchObject({ code: 'CERT_PTI_MISMATCH' });
    expect((await row()).cert_sha256).toBe('old');
    expect(byId(await listCertificateRows(ctx.env.DB, ID))).toEqual({
      [OLD_CERT]: 'active',
      [pending.certId]: 'pending',
    });
  });

  it('refuses a certificate for a different key', async () => {
    const { kit, ca, ctx, row, PTI } = await setup();
    const a = await beginPendingCertificate(ctx, await row());
    const b = await beginPendingCertificate(ctx, await row());
    const der = await issueFromCsr(
      b.csrDer,
      ca,
      { passTypeIdentifier: PTI, teamIdentifier: TEAM },
      { now: kit.clock.now() },
    );
    await expect(
      activatePendingCertificate(ctx, await row(), a.certId, {
        certificateDer: der,
        ascCertificateId: null,
      }),
    ).rejects.toMatchObject({ code: 'KEY_MISMATCH' });
  });

  it('refuses unknown, foreign and already-ended rows with stable codes', async () => {
    const { kit, ca, ctx, row, PTI, OLD_CERT } = await setup();
    const der = new Uint8Array([1]);
    await expect(
      activatePendingCertificate(ctx, await row(), 'missing', {
        certificateDer: der,
        ascCertificateId: null,
      }),
    ).rejects.toMatchObject({ code: 'CERT_PENDING_NOT_FOUND' });
    await expect(
      activatePendingCertificate(ctx, await row(), OLD_CERT, {
        certificateDer: der,
        ascCertificateId: null,
      }),
    ).rejects.toMatchObject({ code: 'CERT_NOT_PENDING' });
    const pending = await beginPendingCertificate(ctx, await row());
    await abandonPendingCertificate(ctx, pending.certId);
    const issued = await issueFromCsr(
      pending.csrDer,
      ca,
      { passTypeIdentifier: PTI, teamIdentifier: TEAM },
      { now: kit.clock.now() },
    );
    await expect(
      activatePendingCertificate(ctx, await row(), pending.certId, {
        certificateDer: issued,
        ascCertificateId: null,
      }),
    ).rejects.toMatchObject({ code: 'CERT_NOT_PENDING' });
  });

  it('abandoning marks the row failed and deletes the unused key', async () => {
    const { ctx, row, ID } = await setup();
    const pending = await beginPendingCertificate(ctx, await row());
    const before = await all(ctx.env.DB, 'SELECT id FROM credentials WHERE fingerprint = ?', [
      pending.pubkeySha256,
    ]);
    expect(before).toHaveLength(1);
    await abandonPendingCertificate(ctx, pending.certId);
    expect(
      await all(ctx.env.DB, 'SELECT id FROM credentials WHERE fingerprint = ?', [
        pending.pubkeySha256,
      ]),
    ).toHaveLength(0);
    const failed = (await listCertificateRows(ctx.env.DB, ID)).find((r) => r.id === pending.certId);
    expect(failed).toMatchObject({ state: 'failed', credential_id: null });
  });
});
