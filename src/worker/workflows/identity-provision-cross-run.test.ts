import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeWwdr, issueFromCsr } from '../modules/identities/cert-fixtures.ts';
import { adoptByPubkey } from '../modules/identities/cert-history.ts';
import { generateCsr } from '../modules/identities/csr.ts';
import { assertIssueBudget } from '../modules/identities/provision-finish.ts';
import { rotateIdentityRows } from '../modules/identities/repo.ts';
import { listCertificateRows } from '../modules/identities/repo-certificates.ts';
import { planRotations } from '../modules/identities/rotation-plan.ts';
import { startProvision, startRotation } from '../modules/identities/run-start.ts';
import { all, first, run } from '../platform/db.ts';
import { type Harness, harness } from './identity-provision-test-fixtures.ts';

const DAY = 86_400_000;

afterEach(() => vi.restoreAllMocks());

const provision = async (h: Harness, handle?: string) => {
  const { runId } = await startProvision(h.kit.ctx, {
    orgId: h.org.id,
    createdBy: null,
    ...(handle ? { handle } : {}),
  });
  return { runId, out: await h.start(runId) };
};

const identity = async (h: Harness) =>
  first<{ id: string; not_after: number; handle: string; credential_id: string }>(
    h.env.DB,
    'SELECT id, not_after, handle, credential_id FROM signing_identities WHERE org_id = ?',
    [h.org.id],
  );

describe('a certificate Apple issued survives a failed run', () => {
  it('adopts it the next day: one order in total', async () => {
    const h = await harness('keep-key');
    await provision(h);
    const id = (await identity(h))?.id ?? '';
    h.kit.clock.advance(300 * DAY);

    // Validation fails for a reason that persists: the chain no longer ends at the expected CA.
    const stranger = await createFakeWwdr(h.kit.clock.now());
    const good = h.env.SIGNER_PLATFORM_INTERMEDIATE;
    Object.assign(h.env, { SIGNER_PLATFORM_INTERMEDIATE: stranger.pem });
    const first1 = await startRotation(h.kit.ctx, { identityId: id, createdBy: null });
    expect(await h.start(first1.runId)).toEqual({ state: 'failed' });
    expect((await h.runRow(first1.runId)).error_code).toBe('CERT_CHAIN_INVALID');
    expect(h.apple.count('createCertificate')).toBe(2);

    h.kit.clock.advance(DAY);
    Object.assign(h.env, { SIGNER_PLATFORM_INTERMEDIATE: good });
    const second = await startRotation(h.kit.ctx, { identityId: id, createdBy: null });
    expect(await h.start(second.runId)).toEqual({ state: 'succeeded' });
    expect(h.apple.count('createCertificate')).toBe(2);
    expect((await listCertificateRows(h.env.DB, id)).map((c) => c.state)).toEqual([
      'superseded',
      'active',
    ]);
  });

  it('refuses to order a listing entry without its content, and prefers the later expiry', async () => {
    await expect(adoptByPubkey([{ der: null }], 'x')).rejects.toMatchObject({
      code: 'ASC_CERT_DER_MISSING',
    });
    const now = Date.UTC(2026, 10, 20);
    const ca = await createFakeWwdr(now);
    const csr = await generateCsr('pass.mobile.passbook.dup');
    const subject = {
      passTypeIdentifier: 'pass.mobile.passbook.dup',
      teamIdentifier: '48H7CLBV8Y',
    };
    const early = { der: await issueFromCsr(csr.csrDer, ca, subject, { now }), expiresAt: 1 };
    const late = { der: await issueFromCsr(csr.csrDer, ca, subject, { now }), expiresAt: 2 };
    expect(await adoptByPubkey([early, late], csr.pubkeySha256)).toBe(late);
  });

  it('stops and alerts after two certificates in 30 days, as the provisioner does', async () => {
    const h = await harness('capped');
    await provision(h);
    const id = (await identity(h))?.id ?? '';
    const now = h.kit.clock.now();
    await run(
      h.env.DB,
      `INSERT INTO identity_certificates (id, identity_id, origin, state, created_at, asc_certificate_id)
       VALUES ('cap-1', ?, 'asc', 'failed', ?, 'a-1')`,
      [id, now],
    );
    const { runId } = await startRotation(h.kit.ctx, { identityId: id, createdBy: null });
    await run(
      h.env.DB,
      "UPDATE identity_runs SET external_ref = json_object('identityId', ?) WHERE id = ?",
      [id, runId],
    );
    await expect(assertIssueBudget(h.kit.ctx, runId)).rejects.toMatchObject({
      code: 'IDENTITY_CERT_CAP',
    });
  });
});

describe('one managed identity per org', () => {
  it('reuses the handle and pass type after a failure and a slug rename', async () => {
    const h = await harness('first-slug');
    h.apple.refuse = true;
    const failed = await provision(h);
    expect(failed.out).toEqual({ state: 'failed' });
    await run(h.env.DB, "UPDATE orgs SET slug = 'renamed-slug' WHERE id = ?", [h.org.id]);
    h.apple.refuse = false;
    const again = await provision(h);
    expect(again.out).toEqual({ state: 'succeeded' });
    const rows = await all<{ handle: string }>(
      h.env.DB,
      'SELECT handle FROM signing_identities WHERE org_id = ?',
      [h.org.id],
    );
    expect(rows).toEqual([{ handle: 'firstslug' }]);
    expect(h.apple.passTypes.size).toBe(1);
  });

  it('refuses another explicit handle once the org has one', async () => {
    const h = await harness('fixed-handle');
    h.apple.refuse = true;
    await provision(h);
    h.apple.refuse = false;
    const other = await provision(h, 'otherhandle');
    expect(other.out).toEqual({ state: 'failed' });
    expect((await h.runRow(other.runId)).error_code).toBe('IDENTITY_HANDLE_FIXED');
    expect(h.apple.passTypes.size).toBe(1);
  });
});

describe('manual renewal', () => {
  it('moves the next rotation, so the planner stays quiet', async () => {
    const h = await harness('manual-renew');
    await provision(h);
    const before = await identity(h);
    const now = h.kit.clock.now();
    const notAfter = (before?.not_after ?? 0) + 365 * DAY;
    await rotateIdentityRows(h.env.DB, {
      identityId: before?.id ?? '',
      oldCredentialId: before?.credential_id ?? null,
      credential: {
        id: 'manual-cred',
        orgId: h.org.id,
        kekVersion: 1,
        iv: new Uint8Array(12),
        wrappedDek: new Uint8Array(60),
        ciphertext: new Uint8Array(16),
        fingerprint: 'manual',
      },
      certPem: 'pem',
      certSha256: 'manual-sha',
      notBefore: now,
      notAfter,
      now,
    });
    const after = await first<{ next_rotation_at: number }>(
      h.env.DB,
      'SELECT next_rotation_at FROM signing_identities WHERE id = ?',
      [before?.id],
    );
    expect(after?.next_rotation_at).toBe(notAfter - 60 * DAY);
    h.kit.clock.set(notAfter - 300 * DAY);
    await planRotations(h.kit.ctx);
    expect(
      await all(h.env.DB, 'SELECT 1 FROM identity_runs WHERE target_id = ?', [before?.id]),
    ).toEqual([]);
  });
});
