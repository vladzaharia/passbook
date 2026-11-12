import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeUser, persistTemplate } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { ConflictError, PreconditionFailedError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createSession, resolveSession } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { acceptOrgInvitation } from '../orgs/membership-service.ts';
import { requireApprovedRelease, type TemplateRelease } from '../templates/releases.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { applyConnectionRecord } from './connection-passes.ts';
import { createPassIdempotent } from './create.ts';
import { requireCredentialRefKeyset } from './credential-keyset.ts';
import { overrideDeps } from './deps.ts';
import { type TenantPassWrite, tenantAuthorityOf } from './http.ts';
import { dailyPasses } from './jobs.ts';
import { rotateLink } from './pass-service-delivery.ts';
import { type Kit, setupKit, TINY_PNG } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';
import { listPasses } from './repo.ts';
import {
  countRegistrations,
  getPass,
  getPassByDownloadToken,
  getPassBySerial,
} from './repo-read-pass.ts';
import { deletePass, listPassSummaries, unvoidPass, updatePass, voidPass } from './service.ts';

let kit: Kit;
let liveRelease: TemplateRelease;
let createPrincipal: {
  actor: { type: 'user'; id: string };
  execution: { kind: 'tenant'; authority: TenantPassWrite };
};
beforeAll(async () => {
  kit = await setupKit();
  liveRelease = await requireApprovedRelease(kit.ctx, kit.template.id, kit.org.id, 'live', 'apple');
  createPrincipal = await passOperator(kit.org.id);
}, 60_000);

const actor = { type: 'user', id: 'admin-1' } as const;
const reviewedRelease = () => ({
  templateVersion: liveRelease.version,
  releaseId: liveRelease.id,
  releaseGeneration: liveRelease.generation,
});

async function passOperator(orgId: string) {
  const user = await makeUser(kit.fx);
  const session = await createSession(kit.ctx, {
    userId: user.id,
    roles: ['user'],
    amr: 'oidc',
    ipPrefix: null,
    userAgent: null,
  });
  const auth = await resolveSession(kit.env, kit.clock, session.cookieValue);
  if (!auth) throw new Error('Pass operator session did not resolve');
  const token = kit.fx.ids.token(32);
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      kit.fx.ids.id(),
      orgId,
      user.primaryEmail,
      JSON.stringify(['pass_operator']),
      await sha256Hex(token),
      now,
      now + 60_000,
    ],
  );
  await acceptOrgInvitation(kit.ctx, auth, token);
  return {
    actor: { type: 'user' as const, id: user.id },
    execution: {
      kind: 'tenant' as const,
      authority: await tenantAuthorityOf(kit.ctx, auth, orgId, 'passes:operate'),
    },
  };
}

describe('create', () => {
  it('stores the object, records version 1 and derives display fields', async () => {
    const pass = await kit.pass({ memberName: 'Sam Lee' });
    expect(pass.version).toBe(1);
    expect(pass.displayTitle).toBe('Sam Lee');
    expect(pass.revision).toBeGreaterThan(0);
    expect(await kit.env.BUCKET.head(pass.objectKey)).not.toBeNull();
    const versions = await all<{ cause: string; pass_json: string }>(
      kit.env.DB,
      'SELECT cause, pass_json FROM pass_versions WHERE pass_id = ?',
      [pass.id],
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]?.cause).toBe('create');
    expect(JSON.parse(versions[0]?.pass_json ?? '{}')).toMatchObject({
      serialNumber: pass.serial,
      organizationName: 'Test Gym',
    });
  });

  it('rejects invalid input without leaving rows or objects behind', async () => {
    const before = await kit.env.BUCKET.list({ prefix: 'passes/' });
    await expect(
      createPassIdempotent(
        kit.ctx,
        {
          orgId: kit.org.id,
          templateId: kit.template.id,
          ...reviewedRelease(),
          input: {},
          source: 'manual',
          mode: 'live',
          ...createPrincipal,
        },
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'PASS_INPUT_INVALID', status: 422 });
    expect((await kit.env.BUCKET.list({ prefix: 'passes/' })).objects).toHaveLength(
      before.objects.length,
    );
  });

  it('refuses a template from another organization', async () => {
    const other = await makeOrg(kit.fx, { name: 'Other Org' });
    const otherPrincipal = await passOperator(other.id);
    const template = kit.registry.add({
      id: `tpl-owned-${kit.fx.ids.token(4)}`,
      orgId: kit.org.id,
      manifest: kit.template.manifest,
      passJson: kit.template.passJson,
      assets: { 'icon.png': TINY_PNG },
    });
    await persistTemplate(kit.fx, template, { registry: kit.registry });
    const release = await approveAppleRelease(kit, {
      orgId: kit.org.id,
      templateId: template.id,
      version: template.version,
    });
    await expect(
      createPassIdempotent(
        kit.ctx,
        {
          orgId: other.id,
          templateId: template.id,
          templateVersion: release.version,
          releaseId: release.id,
          releaseGeneration: release.generation,
          input: { memberName: 'x' },
          source: 'manual',
          mode: 'live',
          ...otherPrincipal,
        },
        undefined,
      ),
    ).rejects.toMatchObject({ status: 404 });
  }, 60_000);

  it('rejects a duplicate serial and removes the stored object', async () => {
    const first = await kit.pass();
    const before = (await kit.env.BUCKET.list({ prefix: 'passes/' })).objects.length;
    await expect(
      createPassIdempotent(
        kit.ctx,
        {
          orgId: kit.org.id,
          templateId: kit.template.id,
          ...reviewedRelease(),
          input: { memberName: 'Dup' },
          serial: first.serial,
          source: 'manual',
          mode: 'live',
          ...createPrincipal,
        },
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'SERIAL_TAKEN' });
    expect((await kit.env.BUCKET.list({ prefix: 'passes/' })).objects).toHaveLength(before);
  });

  it('rejects an invalid holder email', async () => {
    await expect(
      createPassIdempotent(
        kit.ctx,
        {
          orgId: kit.org.id,
          templateId: kit.template.id,
          ...reviewedRelease(),
          input: { memberName: 'x' },
          holderEmail: 'a@b.com,c@d.com',
          source: 'manual',
          mode: 'live',
          ...createPrincipal,
        },
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_INVALID' });
  });
});

describe('idempotency', () => {
  const base = () => ({
    orgId: kit.org.id,
    templateId: kit.template.id,
    ...reviewedRelease(),
    input: { memberName: 'Idem' },
    source: 'manual' as const,
    mode: 'live' as const,
    ...createPrincipal,
  });

  it('returns the original pass for a retry with the same key and body', async () => {
    const key = `key-${kit.fx.ids.token(6)}`;
    const a = await createPassIdempotent(kit.ctx, base(), key);
    const b = await createPassIdempotent(kit.ctx, base(), key);
    expect(b.id).toBe(a.id);
    const count = await first<{ n: number }>(
      kit.env.DB,
      'SELECT count(*) AS n FROM passes WHERE org_id = ? AND display_title = ?',
      [kit.org.id, 'Idem'],
    );
    expect(count?.n).toBe(1);
  });

  it('rejects the same key with a different body', async () => {
    const key = `key-${kit.fx.ids.token(6)}`;
    await createPassIdempotent(kit.ctx, base(), key);
    await expect(
      createPassIdempotent(kit.ctx, { ...base(), input: { memberName: 'Other' } }, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('rejects a key claimed with another body and frees the key after a failed create', async () => {
    const key = `key-${kit.fx.ids.token(6)}`;
    await run(
      kit.env.DB,
      'INSERT INTO idempotency_keys (org_id, key, request_hash, created_at) VALUES (?, ?, ?, ?)',
      [kit.org.id, key, 'h', 1],
    );
    await expect(createPassIdempotent(kit.ctx, base(), key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    const failing = `key-${kit.fx.ids.token(6)}`;
    await expect(
      createPassIdempotent(kit.ctx, { ...base(), input: {} }, failing),
    ).rejects.toMatchObject({ status: 422 });
    const created = await createPassIdempotent(kit.ctx, base(), failing);
    expect(created.id).toBeTruthy();
  });
});

describe('update and CAS publish', () => {
  it('bumps version, writes a new object and queues one push', async () => {
    const pass = await kit.pass({ memberName: 'Before' });
    const detail = await updatePass(
      jobCtxOf(kit),
      actor,
      pass.id,
      { input: { memberName: 'After' } },
      { scope: null },
    );
    expect(detail.version).toBe(2);
    expect(detail.title).toBe('After');
    expect(detail.fieldSources).toEqual({ memberName: 'manual' });
    const updated = await getPass(kit.env.DB, pass.id);
    expect(updated?.objectKey).not.toBe(pass.objectKey);
    expect(updated?.revision).toBeGreaterThan(pass.revision);
    const pushes = await all<{ state: string; id: string }>(
      kit.env.DB,
      "SELECT id, state FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [pass.id],
    );
    expect(pushes).toHaveLength(1);
  });

  it('does not publish when nothing changed', async () => {
    const pass = await kit.pass({ memberName: 'Same' });
    const detail = await updatePass(
      jobCtxOf(kit),
      actor,
      pass.id,
      { input: { memberName: 'Same' } },
      { scope: null },
    );
    expect(detail.version).toBe(1);
  });

  it('fails with 412 on a stale If-Match and leaves the pass untouched', async () => {
    const pass = await kit.pass();
    await updatePass(
      jobCtxOf(kit),
      actor,
      pass.id,
      { input: { memberName: 'v2' } },
      { scope: null },
    );
    await expect(
      updatePass(
        jobCtxOf(kit),
        actor,
        pass.id,
        { input: { memberName: 'v3' } },
        { scope: null, ifMatch: 1 },
      ),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    expect((await getPass(kit.env.DB, pass.id))?.displayTitle).toBe('v2');
  });

  /** The registry runs between our read and our CAS, so a bump there is a lost race. */
  function loseRaces(passId: string, times: number) {
    let left = times;
    overrideDeps(kit.env, {
      registry: {
        list: (q) => kit.registry.list(q),
        openAsset: (t, n) => kit.registry.openAsset(t, n),
        async resolve(id, version) {
          if (left > 0) {
            left--;
            await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [passId]);
          }
          return kit.registry.resolve(id, version);
        },
      },
    });
  }
  const restore = () => overrideDeps(kit.env, { registry: kit.registry });

  it('re-reads and re-applies when a concurrent writer wins the CAS', async () => {
    const pass = await kit.pass({ memberName: 'Race' });
    loseRaces(pass.id, 1);
    const seen: number[] = [];
    const result = await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'connection',
      actor: { type: 'connection', id: 'c1' },
      mutate: (current) => {
        seen.push(current.version);
        return { personalization: { ...current.personalization, memberName: 'Winner' } };
      },
    });
    restore();
    expect(seen).toEqual([1, 2]);
    expect(result.changed).toBe(true);
    expect(result.pass.displayTitle).toBe('Winner');
    expect(result.pass.syncErrorCode).toBeNull();
  });

  it('gives up with 409 after three lost races, without a sync error', async () => {
    const pass = await kit.pass({ memberName: 'Hot' });
    loseRaces(pass.id, 3);
    const attempt = publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'connection',
      actor: { type: 'connection', id: 'c1' },
      mutate: (current) => ({
        personalization: { ...current.personalization, memberName: 'Lost' },
      }),
    });
    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    restore();
    expect((await getPass(kit.env.DB, pass.id))?.syncErrorCode).toBeNull();
    const objects = await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` });
    expect(objects.objects).toHaveLength(1);
  });

  it('coalesces pushes for edits made before the first push starts', async () => {
    const pass = await kit.pass();
    await updatePass(
      jobCtxOf(kit),
      actor,
      pass.id,
      { input: { memberName: 'e1' } },
      { scope: null },
    );
    await updatePass(
      jobCtxOf(kit),
      actor,
      pass.id,
      { input: { memberName: 'e2' } },
      { scope: null },
    );
    const rows = await all<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'",
      [pass.id],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('field sources', () => {
  it('locks manual fields against connection updates and resets them', async () => {
    const pass = await kit.pass({ memberName: 'Manual Name' });
    const credentialKeysetCommitment = await requireCredentialRefKeyset(kit.env.DB, kit.env);
    const connId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'demo', 'c', 1, 1)`,
      [connId, kit.org.id],
    );
    const externalRef = 'manual-reset';
    await run(kit.env.DB, 'UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
      connId,
      externalRef,
      pass.id,
    ]);
    const skipped = await applyConnectionRecord(jobCtxOf(kit), {
      passId: pass.id,
      orgId: kit.org.id,
      mode: 'live',
      status: 'active',
      expectedVersion: pass.version,
      ownerUserId: pass.ownerUserId,
      linkGeneration: pass.linkGeneration,
      identityId: pass.identityId,
      credentialGeneration: pass.credentialGeneration,
      lifecycleGeneration: pass.lifecycleGeneration,
      credentialKeysetCommitment,
      transferPending: false,
      connectionId: connId,
      externalRef,
      generation: 1,
      expectedConnectionMode: 'poll',
      fields: { memberName: 'Upstream' },
      cause: 'connection',
    });
    expect(skipped.changed).toBe(false);
    expect((await getPass(kit.env.DB, pass.id))?.displayTitle).toBe('Manual Name');

    const detail = await updatePass(
      jobCtxOf(kit),
      actor,
      pass.id,
      { resetToConnection: ['memberName'] },
      { scope: null },
    );
    expect(detail.fieldSources).toEqual({});
    const applied = await applyConnectionRecord(jobCtxOf(kit), {
      passId: pass.id,
      orgId: kit.org.id,
      mode: 'live',
      status: 'active',
      expectedVersion: detail.version,
      ownerUserId: pass.ownerUserId,
      linkGeneration: pass.linkGeneration,
      identityId: pass.identityId,
      credentialGeneration: pass.credentialGeneration,
      lifecycleGeneration: pass.lifecycleGeneration,
      credentialKeysetCommitment,
      transferPending: false,
      connectionId: connId,
      externalRef,
      generation: 1,
      expectedConnectionMode: 'poll',
      fields: { memberName: 'Upstream' },
      cause: 'connection',
    });
    expect(applied.changed).toBe(true);
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.displayTitle).toBe('Upstream');
    expect(after?.fieldSources).toEqual({ memberName: 'connection' });
  });

  it('fences runs from an older connection generation', async () => {
    const pass = await kit.pass();
    const credentialKeysetCommitment = await requireCredentialRefKeyset(kit.env.DB, kit.env);
    const connId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at) VALUES (?, ?, 'demo', 'c', 3, 1, 1)`,
      [connId, kit.org.id],
    );
    const externalRef = 'stale-generation';
    await run(kit.env.DB, 'UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
      connId,
      externalRef,
      pass.id,
    ]);
    await expect(
      applyConnectionRecord(jobCtxOf(kit), {
        passId: pass.id,
        orgId: kit.org.id,
        mode: 'live',
        status: 'active',
        expectedVersion: pass.version,
        ownerUserId: pass.ownerUserId,
        linkGeneration: pass.linkGeneration,
        identityId: pass.identityId,
        credentialGeneration: pass.credentialGeneration,
        lifecycleGeneration: pass.lifecycleGeneration,
        credentialKeysetCommitment,
        transferPending: false,
        connectionId: connId,
        externalRef,
        generation: 2,
        expectedConnectionMode: 'poll',
        fields: { memberName: 'Stale' },
        cause: 'connection',
      }),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    expect((await getPass(kit.env.DB, pass.id))?.displayTitle).toBe('Alex Morgan');
  });
});

describe('void, links, delete', () => {
  it('voids and unvoids by rebuilding with voided set', async () => {
    const pass = await kit.pass();
    const voided = await voidPass(jobCtxOf(kit), actor, pass.id, null);
    expect(voided.status).toBe('voided');
    const row = await first<{ pass_json: string }>(
      kit.env.DB,
      'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
      [pass.id],
    );
    expect(JSON.parse(row?.pass_json ?? '{}').voided).toBe(true);
    const back = await unvoidPass(jobCtxOf(kit), actor, pass.id, null);
    expect(back.status).toBe('active');
  });

  it('rotates the download token and keeps the old link dead', async () => {
    const pass = await kit.pass();
    const { publicUrl } = await rotateLink(kit.ctx, actor, pass.id, null);
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.downloadToken).not.toBe(pass.downloadToken);
    expect(publicUrl).toContain(after?.downloadToken ?? 'x');
  });

  it('soft-deletes, keeps serving the voided pass, and hard-deletes after the grace period', async () => {
    const pass = await kit.pass();
    const device = 'dev-delete-1';
    await run(
      kit.env.DB,
      'INSERT INTO devices (device_id, identity_id, push_token, updated_at) VALUES (?, ?, ?, 1)',
      [device, pass.identityId, 'a'.repeat(64)],
    );
    await run(
      kit.env.DB,
      'INSERT INTO registrations (device_id, identity_id, pass_id, created_at) VALUES (?, ?, ?, 1)',
      [device, pass.identityId, pass.id],
    );
    await deletePass(jobCtxOf(kit), actor, pass.id, null);
    expect(await getPass(kit.env.DB, pass.id)).toBeNull();
    expect(await getPassByDownloadToken(kit.env.DB, pass.downloadToken)).toBeNull();
    expect(
      (await listPasses(kit.env.DB, { orgId: pass.orgId, limit: 200 })).items.some(
        (p) => p.id === pass.id,
      ),
    ).toBe(false);
    // The device protocol still resolves the voided pass and its registration.
    const served = await getPassBySerial(kit.env.DB, pass.identityId, pass.serial);
    expect(served?.status).toBe('voided');
    expect(await countRegistrations(kit.env.DB, pass.id)).toBe(1);
    expect(kit.apns.sent.some((s) => s.token === 'a'.repeat(64))).toBe(true);
    await dailyPasses(kit.ctx);
    expect(await getPassBySerial(kit.env.DB, pass.identityId, pass.serial)).not.toBeNull();
    await run(kit.env.DB, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [
      kit.clock.now() - 8 * 86_400_000,
      pass.id,
    ]);
    await dailyPasses(kit.ctx);
    expect(await getPassBySerial(kit.env.DB, pass.identityId, pass.serial)).toBeNull();
    expect((await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects).toHaveLength(0);
    const leftover = await first<{ n: number }>(
      kit.env.DB,
      'SELECT count(*) AS n FROM devices WHERE device_id = ?',
      [device],
    );
    expect(leftover?.n).toBe(0);
  });
});

describe('list', () => {
  it('filters, searches by display prefix and paginates without repeats', async () => {
    const orgB = await kit.fx.ids.id();
    void orgB;
    for (const name of ['Zed One', 'Zed Two', 'Zed Three']) await kit.pass({ memberName: name });
    const first = await listPassSummaries(kit.ctx, { orgId: kit.org.id, q: 'zed', limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await listPassSummaries(kit.ctx, {
      orgId: kit.org.id,
      q: 'zed',
      limit: 2,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    const ids = new Set([...first.items, ...second.items].map((p) => p.id));
    expect(ids.size).toBe(first.items.length + second.items.length);
    expect(second.items.every((p) => (p.title ?? '').startsWith('Zed'))).toBe(true);
    const voidedOnly = await listPassSummaries(kit.ctx, {
      orgId: kit.org.id,
      status: 'voided',
      limit: 50,
    });
    expect(voidedOnly.items.every((p) => p.status === 'voided')).toBe(true);
  });
});
