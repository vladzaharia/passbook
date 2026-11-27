import { afterEach, describe, expect, it, vi } from 'vitest';
import { getIdentityRow } from '../modules/identities/repo.ts';
import { listCertificateRows } from '../modules/identities/repo-certificates.ts';
import { createIdentityResolver } from '../modules/identities/resolver.ts';
import {
  startPlatformProvision,
  startProvision,
  startRotation,
} from '../modules/identities/run-start.ts';
import { identityUsableBy } from '../modules/orgs/repo.ts';
import { all, first, run } from '../platform/db.ts';
import { fakeStep, type Harness, harness } from './identity-provision-test-fixtures.ts';

const DAY = 86_400_000;
const STEPS = [
  'load',
  'pass-type-0',
  'key',
  'issue-0',
  'validate',
  'activate',
  'open',
  'post-check',
  'finish',
];

afterEach(() => vi.restoreAllMocks());

let auditFloor = 0;

/** The worker test database lives for the whole file and each slot sets up once: start every test from none. */
async function fresh(slug: string): Promise<Harness> {
  const h = await harness(slug);
  const db = h.env.DB;
  await run(db, "DELETE FROM identity_runs WHERE target_id LIKE 'platform:%'");
  await run(db, "DELETE FROM signing_identities WHERE org_id IS NULL AND id <> 'platform'");
  auditFloor =
    (await first<{ n: number }>(db, 'SELECT COALESCE(MAX(id), 0) AS n FROM audit_log'))?.n ?? 0;
  return h;
}

async function setUp(h: Harness, slot: 'root' | 'devtest', step = fakeStep()) {
  const { runId } = await startPlatformProvision(h.kit.ctx, { slot, createdBy: null });
  return { runId, out: await h.start(runId, step), step };
}

const rowOf = async (h: Harness, passType: string) => {
  const found = await first<{ id: string }>(
    h.env.DB,
    'SELECT id FROM signing_identities WHERE pass_type_identifier = ?',
    [passType],
  );
  const row = found ? await getIdentityRow(h.env.DB, found.id) : null;
  if (!row) throw new Error(`no identity for ${passType}`);
  return row;
};

const audits = async (h: Harness) =>
  (
    await all<{ action: string; target_type: string; org_id: string | null }>(
      h.env.DB,
      "SELECT action, target_type, org_id FROM audit_log WHERE id > ? AND action LIKE 'identity.%' AND action <> 'identity.apns_probe' ORDER BY id",
      [auditFloor],
    )
  ).map((r) => [r.action, r.target_type, r.org_id]);

describe('platform provision: root', () => {
  it('creates pass.mobile.passbook with no org, open to passes and not the default', async () => {
    const h = await fresh('root-co');
    const { runId, out } = await setUp(h, 'root');
    expect(out).toEqual({ state: 'succeeded' });
    expect(await h.runRow(runId)).toMatchObject({
      state: 'succeeded',
      step: 'finish',
      org_id: null,
      target_type: 'identity',
      target_id: 'platform:root',
    });

    const row = await rowOf(h, 'pass.mobile.passbook');
    expect(row).toMatchObject({
      org_id: null,
      team_identifier: '48H7CLBV8Y',
      source: 'db',
      provenance: 'platform',
      rotation: 'auto',
      purpose: 'passes',
      handle: null,
      is_default: 0,
      issuing: 1,
    });
    expect(row.cert_pem).toContain('BEGIN CERTIFICATE');
    expect(row.apns_binding).toBeNull();
    const state = await first(
      h.env.DB,
      'SELECT asc_pass_type_id, asc_account, next_rotation_at FROM signing_identities WHERE id = ?',
      [row.id],
    );
    expect(state).toEqual({
      asc_pass_type_id: 'asc-pt-root',
      asc_account: 'platform',
      next_rotation_at: (row.not_after ?? 0) - 60 * DAY,
    });
    expect((await listCertificateRows(h.env.DB, row.id)).map((c) => [c.state, c.origin])).toEqual([
      ['active', 'asc'],
    ]);
    // Nothing defaults to it and no org points at it.
    expect(
      await first(
        h.env.DB,
        "SELECT id FROM signing_identities WHERE is_default = 1 AND id <> 'platform'",
      ),
    ).toBeNull();
    expect(
      await first(h.env.DB, 'SELECT id FROM orgs WHERE default_identity_id = ?', [row.id]),
    ).toBeNull();
    expect(h.apple.calls.filter((c) => c !== 'listCertificates')).toEqual([
      'findPassType',
      'createPlatformPassType',
      'createCertificate',
      'reportCertificateActive',
    ]);
    expect(await audits(h)).toEqual([
      ['identity.provision_requested', 'identity', null],
      ['identity.pass_type_created', 'identity', null],
      ['identity.certificate_issued', 'identity', null],
      ['identity.provisioned', 'identity', null],
    ]);
  });

  it('adopts a pass type Apple already has without creating one', async () => {
    const h = await fresh('root-adopt');
    h.apple.passTypes.set('pass.mobile.passbook', {
      ascId: 'asc-existing',
      identifier: 'pass.mobile.passbook',
      name: 'PassBook',
    });
    expect((await setUp(h, 'root')).out).toEqual({ state: 'succeeded' });
    expect(h.apple.count('createPlatformPassType')).toBe(0);
    expect((await rowOf(h, 'pass.mobile.passbook')).issuing).toBe(1);
  });

  it('refuses a second set up and holds one open run per slot', async () => {
    const h = await fresh('root-twice');
    const a = await startPlatformProvision(h.kit.ctx, { slot: 'root', createdBy: null });
    const b = await startPlatformProvision(h.kit.ctx, { slot: 'root', createdBy: null });
    expect(b).toEqual({ runId: a.runId, created: false });
    const other = await startPlatformProvision(h.kit.ctx, { slot: 'devtest', createdBy: null });
    expect(other.runId).not.toBe(a.runId);
    await h.start(a.runId);
    await expect(
      startPlatformProvision(h.kit.ctx, { slot: 'root', createdBy: null }),
    ).rejects.toMatchObject({ code: 'IDENTITY_ALREADY_PROVISIONED' });
  });

  it('fails the run when a run for a set up slot is already open', async () => {
    const h = await fresh('root-stale');
    const { runId } = await startPlatformProvision(h.kit.ctx, { slot: 'root', createdBy: null });
    await h.start(runId);
    // A run created before the first one finished: its load refuses.
    await run(
      h.env.DB,
      `INSERT INTO identity_runs (id, org_id, provider, kind, target_type, target_id, state, external_ref, created_at, updated_at)
       VALUES ('late', NULL, 'apple', 'provision', 'identity', 'platform:root', 'queued', '{"platformSlot":"root"}', 1, 1)`,
    );
    expect(await h.start('late')).toEqual({ state: 'failed' });
    expect(await h.runRow('late')).toMatchObject({ error_code: 'IDENTITY_ALREADY_PROVISIONED' });
    expect(h.apple.count('createCertificate')).toBe(1);
  });

  it('runs the expected steps', async () => {
    const h = await fresh('root-steps');
    const { step } = await setUp(h, 'root');
    expect(step.names.filter((n) => n !== 'report-0')).toEqual(STEPS);
  });

  it.each(STEPS)('runs %s twice without a second effect', async (name) => {
    const h = await fresh(`root-twice-${name}`);
    const { out } = await setUp(h, 'root', fakeStep({ twice: [name] }));
    expect(out).toEqual({ state: 'succeeded' });
    const row = await rowOf(h, 'pass.mobile.passbook');
    expect((await listCertificateRows(h.env.DB, row.id)).map((c) => c.state)).toEqual(['active']);
    expect(h.apple.count('createCertificate')).toBe(1);
    expect(
      await first(
        h.env.DB,
        'SELECT count(*) AS n FROM signing_identities WHERE pass_type_identifier = ?',
        ['pass.mobile.passbook'],
      ),
    ).toEqual({ n: 1 });
    expect((await audits(h)).map(([a]) => a)).toEqual([
      'identity.provision_requested',
      'identity.pass_type_created',
      'identity.certificate_issued',
      'identity.provisioned',
    ]);
  });

  it('adopts the pass type and the certificate when a response was lost', async () => {
    const h = await fresh('root-drop');
    h.apple.dropNext = 'createPlatformPassType';
    expect((await setUp(h, 'root')).out).toEqual({ state: 'succeeded' });
    const again = await fresh('root-drop-cert');
    again.apple.dropNext = 'createCertificate';
    expect((await setUp(again, 'root')).out).toEqual({ state: 'succeeded' });
    expect(again.apple.count('createCertificate')).toBe(1);
    expect(again.apple.count('listCertificates')).toBe(2);
  });

  it('fails closed with a stable code when Apple returns another pass type', async () => {
    const h = await fresh('root-wrong');
    h.apple.wrongIdentifier = 'pass.mobile.passbook.other';
    const { runId, out } = await setUp(h, 'root');
    expect(out).toEqual({ state: 'failed' });
    expect(await h.runRow(runId)).toMatchObject({ error_code: 'IDENTITY_PASS_TYPE_MISMATCH' });
    expect(
      await first(
        h.env.DB,
        "SELECT id FROM signing_identities WHERE handle IS NULL AND provenance = 'platform' AND pass_type_identifier <> 'pass.im.plrs.wallet'",
      ),
    ).toBeNull();
    expect(h.apple.count('createCertificate')).toBe(0);
  });

  it('parks while the provisioner is unavailable', async () => {
    const h = await fresh('root-parked');
    h.setApple(false);
    const { runId } = await startPlatformProvision(h.kit.ctx, { slot: 'root', createdBy: null });
    const step = fakeStep({
      onSleep: async () => {
        expect((await h.runRow(runId)).waiting_for).toBe('apple_unavailable');
        h.setApple(true);
      },
    });
    expect(await h.start(runId, step)).toEqual({ state: 'succeeded' });
    expect(step.sleeps).toEqual(['pass-type-wait-0']);
  });

  it('rotates with no new code, and keeps the org out of it', async () => {
    const h = await fresh('root-rotate');
    await setUp(h, 'root');
    const row = await rowOf(h, 'pass.mobile.passbook');
    h.kit.clock.advance(300 * DAY);
    const rotation = await startRotation(h.kit.ctx, { identityId: row.id, createdBy: null });
    expect(await h.start(rotation.runId)).toEqual({ state: 'succeeded' });
    expect((await listCertificateRows(h.env.DB, row.id)).map((c) => c.state)).toEqual([
      'superseded',
      'active',
    ]);
    expect(h.apple.count('createPlatformPassType')).toBe(1);
  });
});

describe('platform provision: devtest', () => {
  it('creates the device-test identity under the reserved handle', async () => {
    const h = await fresh('dev-co');
    const { out } = await setUp(h, 'devtest');
    expect(out).toEqual({ state: 'succeeded' });
    expect(await rowOf(h, 'pass.mobile.passbook.devtest')).toMatchObject({
      org_id: null,
      provenance: 'platform',
      rotation: 'auto',
      purpose: 'device_test',
      handle: 'devtest',
      is_default: 0,
      issuing: 1,
    });
    expect(
      await first(h.env.DB, 'SELECT org_id FROM identity_handles WHERE handle = ?', ['devtest']),
    ).toEqual({ org_id: null });
  });

  it('refuses when an org holds the handle', async () => {
    const h = await fresh('dev-held');
    await run(h.env.DB, 'DROP TRIGGER IF EXISTS identity_handles_no_reassign');
    await run(h.env.DB, "UPDATE identity_handles SET org_id = ? WHERE handle = 'devtest'", [
      h.org.id,
    ]);
    const { runId, out } = await setUp(h, 'devtest');
    expect(out).toEqual({ state: 'failed' });
    expect(await h.runRow(runId)).toMatchObject({ error_code: 'IDENTITY_HANDLE_TAKEN' });
    expect(h.apple.calls).toEqual([]);
    await run(h.env.DB, "UPDATE identity_handles SET org_id = NULL WHERE handle = 'devtest'");
  });

  it('is never an org handle', async () => {
    const h = await fresh('dev-org');
    const { runId } = await startProvision(h.kit.ctx, {
      orgId: h.org.id,
      handle: 'devtest',
      createdBy: null,
    });
    expect(await h.start(runId)).toEqual({ state: 'failed' });
    expect(await h.runRow(runId)).toMatchObject({ error_code: 'IDENTITY_HANDLE_RESERVED' });
    expect(h.apple.calls).toEqual([]);
  });

  it('no org can sign on it: named, as its default or as the global default', async () => {
    const h = await fresh('dev-sign');
    await setUp(h, 'devtest');
    await setUp(h, 'root');
    const dev = await rowOf(h, 'pass.mobile.passbook.devtest');
    const root = await rowOf(h, 'pass.mobile.passbook');
    const resolver = createIdentityResolver(h.env);
    const now = h.kit.clock.now();
    const refused = { code: 'IDENTITY_NOT_FOUND' };

    await expect(resolver.forOrg(h.org.id, dev.id, now)).rejects.toMatchObject(refused);

    await run(h.env.DB, 'UPDATE orgs SET default_identity_id = ? WHERE id = ?', [dev.id, h.org.id]);
    await expect(resolver.forOrg(h.org.id, null, now)).rejects.toMatchObject(refused);
    await run(h.env.DB, 'UPDATE orgs SET default_identity_id = NULL WHERE id = ?', [h.org.id]);

    await run(h.env.DB, "UPDATE signing_identities SET is_default = 0 WHERE id = 'platform'");
    await run(h.env.DB, 'UPDATE signing_identities SET is_default = 1 WHERE id = ?', [dev.id]);
    await expect(resolver.forOrg(h.org.id, null, now)).rejects.toMatchObject(refused);
    await run(h.env.DB, 'UPDATE signing_identities SET is_default = 0 WHERE id = ?', [dev.id]);
    await run(h.env.DB, "UPDATE signing_identities SET is_default = 1 WHERE id = 'platform'");

    // An org cannot even choose it as its default.
    expect(await identityUsableBy(h.env.DB, dev.id, h.org.id)).toBe(false);
    expect(await identityUsableBy(h.env.DB, root.id, h.org.id)).toBe(true);

    // The device-test path still resolves it by id, and an org can still use the root.
    expect((await resolver.byId(dev.id)).passTypeIdentifier).toBe('pass.mobile.passbook.devtest');
    expect((await resolver.forOrg(h.org.id, root.id, now)).id).toBe(root.id);
  });
});
