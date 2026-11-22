import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeOrg } from '../../../test/helpers/index.ts';
import { getIdentityRow } from '../modules/identities/repo.ts';
import { listCertificateRows } from '../modules/identities/repo-certificates.ts';
import { startProvision, startRotation } from '../modules/identities/run-start.ts';
import { all, first, run } from '../platform/db.ts';
import {
  auditActions,
  fakeStep,
  type Harness,
  harness,
} from './identity-provision-test-fixtures.ts';

const DAY = 86_400_000;

afterEach(() => vi.restoreAllMocks());

async function provision(h: Harness, handle?: string, step = fakeStep()) {
  const { runId } = await startProvision(h.kit.ctx, {
    orgId: h.org.id,
    createdBy: null,
    ...(handle ? { handle } : {}),
  });
  const out = await h.start(runId, step);
  return { runId, out, step };
}

async function identityOf(h: Harness) {
  const row = await first<{ id: string }>(
    h.env.DB,
    "SELECT id FROM signing_identities WHERE org_id = ? AND provenance = 'managed'",
    [h.org.id],
  );
  if (!row) throw new Error('no managed identity');
  const identity = await getIdentityRow(h.env.DB, row.id);
  if (!identity) throw new Error('no identity');
  return identity;
}

describe('provision', () => {
  it('creates the pass type, certificate and identity, and defaults new passes to it', async () => {
    const h = await harness('henrys-gym');
    const { runId, out } = await provision(h);
    expect(out).toEqual({ state: 'succeeded' });

    const row = await h.runRow(runId);
    expect(row).toMatchObject({ state: 'succeeded', step: 'finish', error_code: null });
    const identity = await identityOf(h);
    expect(identity).toMatchObject({
      pass_type_identifier: 'pass.mobile.passbook.henrysgym',
      team_identifier: '48H7CLBV8Y',
      provenance: 'managed',
      rotation: 'auto',
      issuing: 1,
    });
    expect(identity.cert_pem).toContain('BEGIN CERTIFICATE');
    const state = await first<Record<string, unknown>>(
      h.env.DB,
      'SELECT handle, asc_pass_type_id, asc_account, next_rotation_at FROM signing_identities WHERE id = ?',
      [identity.id],
    );
    expect(state).toMatchObject({
      handle: 'henrysgym',
      asc_pass_type_id: 'asc-pt-henrysgym',
      asc_account: 'platform',
      next_rotation_at: (identity.not_after ?? 0) - 60 * DAY,
    });
    expect(
      await first(h.env.DB, 'SELECT org_id FROM identity_handles WHERE handle = ?', ['henrysgym']),
    ).toEqual({ org_id: h.org.id });
    const org = await first<{ default_identity_id: string }>(
      h.env.DB,
      'SELECT default_identity_id FROM orgs WHERE id = ?',
      [h.org.id],
    );
    expect(org?.default_identity_id).toBe(identity.id);
    const certs = await listCertificateRows(h.env.DB, identity.id);
    expect(certs.map((c) => [c.state, c.origin, c.asc_certificate_id])).toEqual([
      ['active', 'asc', 'asc-cert-1'],
    ]);
    expect(h.apple.count('createPassType')).toBe(1);
    expect(h.apple.count('createCertificate')).toBe(1);
    expect(h.apple.reported).toEqual(['asc-cert-1']);
    expect(await auditActions(h.env.DB, h.org.id)).toEqual([
      'identity.provision_requested',
      'identity.pass_type_created',
      'identity.certificate_issued',
      'identity.provisioned',
      'identity.apns_probe',
    ]);
  });

  it('appends 2 on a handle collision and refuses reserved or invalid handles', async () => {
    const taken = await harness('acme');
    await provision(taken);
    expect(
      (
        await first<{ handle: string }>(
          taken.env.DB,
          'SELECT handle FROM signing_identities WHERE org_id = ?',
          [taken.org.id],
        )
      )?.handle,
    ).toBe('acme');

    // A second org whose slug reduces to the same handle.
    const { id: orgB } = await makeOrg(taken.kit.fx, { slug: 'acme-', name: 'Acme B' });
    const started = await startProvision(taken.kit.ctx, { orgId: orgB, createdBy: null });
    await taken.start(started.runId);
    const b = await first<{ handle: string }>(
      taken.env.DB,
      'SELECT handle FROM signing_identities WHERE org_id = ?',
      [orgB],
    );
    expect(b?.handle).toBe('acme2');

    for (const [slug, requested, code] of [
      ['wallet', undefined, 'IDENTITY_HANDLE_RESERVED'],
      ['res-admin', 'admin', 'IDENTITY_HANDLE_RESERVED'],
      ['bad-handle', 'Bad-Handle', 'IDENTITY_HANDLE_INVALID'],
    ] as const) {
      const h = await harness(slug);
      const { runId, out } = await provision(h, requested);
      expect(out).toEqual({ state: 'failed' });
      expect((await h.runRow(runId)).error_code).toBe(code);
      expect(h.apple.calls).toEqual([]);
    }
  });

  it('fails the run when Apple answers with a pass type the org did not reserve', async () => {
    const h = await harness('mismatch-co');
    h.apple.wrongIdentifier = 'pass.mobile.passbook.someoneelse';
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runId, out } = await provision(h);
    expect(out).toEqual({ state: 'failed' });
    expect((await h.runRow(runId)).error_code).toBe('IDENTITY_PASS_TYPE_MISMATCH');
    expect(h.apple.count('createCertificate')).toBe(0);
    expect(JSON.stringify(warn.mock.calls)).toContain('identity.pass_type_mismatch');
  });

  it('refuses to delete or reassign a reserved handle', async () => {
    const h = await harness('reserved-co');
    await provision(h);
    await expect(
      run(h.env.DB, "DELETE FROM identity_handles WHERE handle = 'reservedco'"),
    ).rejects.toThrow(/IDENTITY_HANDLE_RESERVED/);
    await expect(
      run(h.env.DB, "DELETE FROM identity_handles WHERE handle = 'wallet'"),
    ).rejects.toThrow(/IDENTITY_HANDLE_RESERVED/);
  });

  it('holds one open run per target', async () => {
    const h = await harness('one-run');
    const a = await startProvision(h.kit.ctx, { orgId: h.org.id, createdBy: null });
    const b = await startProvision(h.kit.ctx, { orgId: h.org.id, createdBy: null });
    expect(a.created).toBe(true);
    expect(b).toEqual({ runId: a.runId, created: false });
    expect(h.workflow.created.map((c) => c.id)).toEqual([a.runId]);
    await h.start(a.runId);
    const c = await startProvision(h.kit.ctx, { orgId: h.org.id, createdBy: null });
    expect(c.created).toBe(true);
    // The finished run's workflow already made the identity: the next run refuses.
    expect(await h.start(c.runId)).toEqual({ state: 'failed' });
    expect((await h.runRow(c.runId)).error_code).toBe('IDENTITY_ALREADY_PROVISIONED');
  });
});

describe('rotate', () => {
  it('replaces the certificate, supersedes the old one and moves the schedule', async () => {
    const h = await harness('rotate-co');
    await provision(h);
    const before = await identityOf(h);
    h.kit.clock.advance(305 * DAY);
    const { runId } = await startRotation(h.kit.ctx, { identityId: before.id, createdBy: null });
    expect(await h.start(runId)).toEqual({ state: 'succeeded' });

    const after = await identityOf(h);
    expect(after.cert_sha256).not.toBe(before.cert_sha256);
    expect(after.not_after).toBeGreaterThan(before.not_after ?? 0);
    expect(after.credential_id).not.toBe(before.credential_id);
    expect(
      (await listCertificateRows(h.env.DB, before.id)).map((c) => [c.state, c.asc_certificate_id]),
    ).toEqual([
      ['superseded', 'asc-cert-1'],
      ['active', 'asc-cert-2'],
    ]);
    expect(
      (
        await first<{ n: number }>(
          h.env.DB,
          'SELECT next_rotation_at AS n FROM signing_identities WHERE id = ?',
          [before.id],
        )
      )?.n,
    ).toBe((after.not_after ?? 0) - 60 * DAY);
    expect(h.apple.count('createPassType')).toBe(1);
    expect(h.apple.count('createCertificate')).toBe(2);
    expect(
      (
        await all<{ action: string }>(
          h.env.DB,
          "SELECT action FROM audit_log WHERE target_id = ? AND action = 'identity.rotated'",
          [before.id],
        )
      ).length,
    ).toBe(1);
  });
});
