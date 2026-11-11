import { describe, expect, it, vi } from 'vitest';
import { makeUser, persistTemplate } from '../../../../test/helpers/index.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createSession, resolveSession } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  getWalletInstanceById,
  newWalletClaimHandle,
} from '../wallet-providers/instance.ts';
import { reconcileWalletInstance } from '../wallet-providers/lifecycle.ts';
import { makeProviderTestTemplate } from '../wallet-providers/offers-test-fixtures.ts';
import { finishWalletProviderRetirement } from '../wallet-providers/sync-operation-retirement.ts';
import { approveAppleRelease, grantKitMembership } from './apple-release-test-fixtures.ts';
import { createPassRow } from './create.ts';
import { credentialRefKeysetCommitment, requireCredentialRefKeyset } from './credential-keyset.ts';
import { credentialTombstoneRef } from './credential-tombstones.ts';
import { finishCredentialTransfer, startCredentialTransfer } from './credential-transfer.ts';
import { resumePendingCredentialTransfers } from './credential-transfer-resume.ts';
import { tenantAuthorityOf } from './http.ts';
import { ICON_PNG, type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';

const system = { type: 'system', id: null } as const;
const target = { holderEmail: 'next@example.test', ownerUserId: null } as const;

const deferred = Promise;

async function source(kit: Kit, id: string) {
  const expected = await getHolderPass(kit.env.DB, id, null);
  if (!expected) throw new Error('Missing holder source');
  return expected;
}

async function begin(kit: Kit, id: string, next = target) {
  return startCredentialTransfer(jobCtxOf(kit), system, id, next, null, {
    kind: 'tenant-holder',
    expected: await source(kit, id),
  });
}

function uploadGate(kit: Kit, id: string) {
  const arrived = deferred.withResolvers<void>();
  const gate = deferred.withResolvers<void>();
  const original = kit.env.BUCKET.put.bind(kit.env.BUCKET);
  const spy = vi.spyOn(kit.env.BUCKET, 'put').mockImplementation(async (key, bytes, options) => {
    if (key.startsWith(`passes/${id}/`)) {
      arrived.resolve();
      await gate.promise;
    }
    return original(key, bytes, options);
  });
  return { arrived: arrived.promise, release: gate.resolve, spy };
}

describe('credential transfer', () => {
  it('atomically revokes old links, devices and bundle access and publishes fresh credentials', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    await kit.device(pass, 'old-device', 'a'.repeat(64));
    const bundle = kit.ctx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO bundles (id,org_id,name,token,created_at) VALUES (?,?,'old',?,?)`,
      [bundle, pass.orgId, kit.ctx.ids.token(), kit.clock.now()],
    );
    await run(kit.env.DB, 'INSERT INTO bundle_passes (bundle_id,pass_id,position) VALUES (?,?,0)', [
      bundle,
      pass.id,
    ]);
    await run(
      kit.env.DB,
      `INSERT INTO pass_personalizations
      (pass_id,token_sha256,kek_version,iv,wrapped_dek,ciphertext,created_at) VALUES (?,?,1,?,?,?,?)`,
      [
        pass.id,
        'a'.repeat(64),
        new Uint8Array([1]),
        new Uint8Array([2]),
        new Uint8Array([3]),
        kit.clock.now(),
      ],
    );
    const result = await begin(kit, pass.id);
    expect(result.state).toBe('completed');
    const changed = await getPass(kit.env.DB, pass.id);
    if (!changed) throw new Error('Missing transferred pass');
    expect(changed).toMatchObject({
      credentialGeneration: pass.credentialGeneration + 1,
      linkGeneration: pass.linkGeneration + 1,
      holderEmail: target.holderEmail,
      ownerUserId: null,
      version: pass.version + 1,
    });
    expect(changed.serial).not.toBe(pass.serial);
    expect(changed.authToken).not.toBe(pass.authToken);
    expect(changed.downloadToken).not.toBe(pass.downloadToken);
    expect(changed.scanCode).not.toBe(pass.scanCode);
    expect(changed.objectKey).not.toBe(pass.objectKey);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM registrations WHERE pass_id = ?', [pass.id]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_personalizations WHERE pass_id = ?', [pass.id]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM bundle_passes WHERE pass_id = ?', [pass.id]),
    ).toBeNull();
    const tombstones = await all<{ credential_kind: string; credential_hash: string }>(
      kit.env.DB,
      'SELECT credential_kind, credential_hash FROM pass_credential_tombstones WHERE pass_id = ?',
      [pass.id],
    );
    expect(tombstones.map((row) => row.credential_kind)).toContain('serial');
    expect(tombstones.map((row) => row.credential_kind)).toContain('scan_code');
    expect(JSON.stringify(tombstones)).not.toContain(pass.serial);
    if (pass.scanCode) expect(JSON.stringify(tombstones)).not.toContain(pass.scanCode);
    expect(
      await first(
        kit.env.DB,
        `SELECT state,source_generation,target_generation,source_link_generation
      FROM pass_credential_transfers WHERE id = ?`,
        [result.transferId],
      ),
    ).toEqual({
      state: 'completed',
      source_generation: pass.credentialGeneration,
      target_generation: pass.credentialGeneration + 1,
      source_link_generation: pass.linkGeneration + 1,
    });
    expect(await finishCredentialTransfer(jobCtxOf(kit), result.transferId)).toEqual(result);
    expect(
      await first(
        kit.env.DB,
        "SELECT 1 FROM audit_log WHERE target_id = ? AND action = 'pass.transfer_completed'",
        [pass.id],
      ),
    ).not.toBeNull();
  }, 120_000);

  it('rolls back the transfer reservation and revocations if the start audit fails', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    await kit.device(pass, 'retained-device', 'a'.repeat(64));
    const providers = await all(
      kit.env.DB,
      'SELECT * FROM wallet_provider_instances WHERE pass_id = ? ORDER BY id',
      [pass.id],
    );
    const providerAuthority = await first(
      kit.env.DB,
      'SELECT generation FROM wallet_provider_pass_authority WHERE pass_id = ?',
      [pass.id],
    );
    await run(
      kit.env.DB,
      `CREATE TRIGGER fail_transfer_start_audit BEFORE INSERT ON audit_log
      WHEN NEW.action = 'pass.transfer_started' AND NEW.target_id = '${pass.id}'
      BEGIN SELECT RAISE(ABORT, 'forced transfer start rollback'); END`,
    );
    try {
      await expect(begin(kit, pass.id)).rejects.toThrow('forced transfer start rollback');
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER fail_transfer_start_audit');
    }
    expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
      credentialGeneration: pass.credentialGeneration,
      linkGeneration: pass.linkGeneration,
      downloadToken: pass.downloadToken,
      holderEmail: pass.holderEmail,
    });
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_credential_transfers WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_credential_tombstones WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM registrations WHERE pass_id = ?', [pass.id]),
    ).not.toBeNull();
    expect(
      await all(
        kit.env.DB,
        'SELECT * FROM wallet_provider_instances WHERE pass_id = ? ORDER BY id',
        [pass.id],
      ),
    ).toEqual(providers);
    expect(
      await first(
        kit.env.DB,
        'SELECT generation FROM wallet_provider_pass_authority WHERE pass_id = ?',
        [pass.id],
      ),
    ).toEqual(providerAuthority);
  }, 120_000);

  it('pins the keyset for the entire transfer despite environment mutation', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    if (!pass.scanCode) throw new Error('Missing scan code');
    const originalEnv = { ...kit.env };
    const previous = kit.env.KEK_V1;
    const ctx = jobCtxOf(kit);
    const makeId = ctx.ids.id.bind(ctx.ids);
    let changed = false;
    // Credential generation runs after the context snapshot and before reference derivation.
    const spy = vi.spyOn(ctx.ids, 'id').mockImplementation(() => {
      if (!changed) {
        changed = true;
        kit.env.KEK_V1 = btoa('x'.repeat(32));
      }
      return makeId();
    });
    try {
      const started = await startCredentialTransfer(ctx, system, pass.id, target, null, {
        kind: 'tenant-holder',
        expected: await source(kit, pass.id),
      });
      expect(started.state).toBe('completed');
    } finally {
      spy.mockRestore();
      kit.env.KEK_V1 = previous;
    }
    expect(changed).toBe(true);
    const commitment = await credentialRefKeysetCommitment(originalEnv);
    expect(
      await credentialRefKeysetCommitment({ ...originalEnv, KEK_V1: btoa('x'.repeat(32)) }),
    ).not.toBe(commitment);
    expect(
      await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
    ).toEqual({ commitment });
    const hash = await credentialTombstoneRef(
      originalEnv,
      pass.orgId,
      pass.mode,
      await sha256Hex(pass.scanCode),
    );
    expect(
      await first(
        kit.env.DB,
        `SELECT 1 FROM pass_credential_tombstones
      WHERE pass_id = ? AND credential_kind = 'scan_code' AND credential_hash = ?`,
        [pass.id, hash],
      ),
    ).not.toBeNull();
  }, 120_000);

  it.each(['barcode', 'lookup'] as const)(
    'rejects an unchanged accepted %s before revoking anything',
    async (kind) => {
      const kit = await setupKit();
      const id = `transfer-${kind}-${kit.ctx.ids.token(5)}`;
      const manifest = {
        ...kit.template.manifest,
        name: `Fixed ${kind}`,
        ...(kind === 'lookup'
          ? {
              scan: {
                actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' as const }],
                lookup: { input: 'memberName' },
              },
            }
          : {}),
      };
      const json = {
        ...kit.template.passJson,
        ...(kind === 'barcode'
          ? {
              barcodes: [
                {
                  format: 'PKBarcodeFormatQR',
                  message: 'fixed-card-number',
                  messageEncoding: 'iso-8859-1',
                },
              ],
            }
          : {}),
      } as PassJson;
      const template = kit.registry.add({
        id,
        orgId: kit.org.id,
        manifest,
        passJson: json,
        assets: { 'icon.png': ICON_PNG },
      });
      await persistTemplate(kit.fx, template, { registry: kit.registry });
      const release = await approveAppleRelease(kit, { templateId: id, version: template.version });
      const pass = await createPassRow(jobCtxOf(kit), {
        orgId: kit.org.id,
        templateId: id,
        templateVersion: release.version,
        releaseId: release.id,
        releaseGeneration: release.generation,
        input: { memberName: 'Same number' },
        holderEmail: null,
        source: 'manual',
        mode: 'live',
        execution: { kind: 'system' },
        actor: system,
      });
      const before = await getPass(kit.env.DB, pass.id);
      await expect(begin(kit, pass.id)).rejects.toMatchObject({ code: 'PASS_REISSUE_REQUIRED' });
      expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
        credentialGeneration: before?.credentialGeneration,
        linkGeneration: before?.linkGeneration,
        downloadToken: before?.downloadToken,
        serial: before?.serial,
      });
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_credential_transfers WHERE pass_id = ?', [
          pass.id,
        ]),
      ).toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_credential_tombstones WHERE pass_id = ?', [
          pass.id,
        ]),
      ).toBeNull();
    },
    120_000,
  );

  it('does not reserve a transfer or leave side effects when the reviewed pass snapshot is stale', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const expected = await source(kit, pass.id);
    await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]);
    await expect(
      startCredentialTransfer(jobCtxOf(kit), system, pass.id, target, null, {
        kind: 'tenant-holder',
        expected,
      }),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    const after = await getPass(kit.env.DB, pass.id);
    expect(after).toMatchObject({
      credentialGeneration: pass.credentialGeneration,
      downloadToken: pass.downloadToken,
      holderEmail: pass.holderEmail,
    });
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_credential_transfers WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_credential_tombstones WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
  }, 120_000);

  it('rechecks a tenant session after signing and leaves the reservation uncreated when revoked', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    await kit.device(pass, 'authority-device', 'a'.repeat(64));
    const user = await makeUser(kit.fx);
    await grantKitMembership(kit, pass.orgId, user.id);
    const session = await createSession(jobCtxOf(kit), {
      userId: user.id,
      roles: ['user'],
      amr: 'oidc',
      ipPrefix: null,
      userAgent: null,
    });
    const resolved = await resolveSession(kit.env, kit.clock, session.cookieValue);
    if (!resolved) throw new Error('Missing tenant session');
    const authority = await tenantAuthorityOf(
      jobCtxOf(kit),
      { ...resolved, mode: 'live' },
      pass.orgId,
      'passes:operate',
    );
    if (authority.kind !== 'session') throw new Error('Expected session authority');
    const control = await kit.pass();
    expect(
      (
        await startCredentialTransfer(
          jobCtxOf(kit),
          { type: 'user', id: user.id },
          control.id,
          target,
          null,
          { kind: 'tenant-holder', expected: await source(kit, control.id), authority },
        )
      ).state,
    ).toBe('completed');
    const expected = await source(kit, pass.id);
    const db = kit.env.DB;
    const reservationStatements = new WeakSet<D1PreparedStatement>();
    let changed = false;
    // Intervene immediately before the real reservation batch, after the artifact was signed.
    const racedDb = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes('INSERT INTO pass_credential_transfers')) return statement;
            return new Proxy(statement, {
              get(prepared, key) {
                if (key === 'bind')
                  return (...values: unknown[]) => {
                    const bound = prepared.bind(...values);
                    reservationStatements.add(bound);
                    return bound;
                  };
                const value = Reflect.get(prepared, key, prepared);
                return typeof value === 'function' ? value.bind(prepared) : value;
              },
            });
          };
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (!changed && statements.some((statement) => reservationStatements.has(statement))) {
              const update = await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
                kit.clock.now(),
                authority.sessionId,
              ]);
              expect(update.changes).toBe(1);
              changed = true;
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ctx = { ...jobCtxOf(kit), env: { ...kit.env, DB: racedDb } };
    await expect(
      startCredentialTransfer(ctx, { type: 'user', id: user.id }, pass.id, target, null, {
        kind: 'tenant-holder',
        expected,
        authority,
      }),
      // The session was revoked between read and commit: an actor refusal (403), no longer a conflict.
    ).rejects.toMatchObject({ status: 403 });
    expect(changed).toBe(true);
    expect(await resolveSession(kit.env, kit.clock, session.cookieValue)).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_credential_transfers WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_credential_tombstones WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM registrations WHERE pass_id = ?', [pass.id]),
    ).not.toBeNull();
    expect(
      await first(
        kit.env.DB,
        "SELECT 1 FROM audit_log WHERE target_id = ? AND action = 'pass.transfer_started'",
        [pass.id],
      ),
    ).toBeNull();
    const objects = await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` });
    expect(objects.objects.map((object) => object.key)).toEqual([pass.objectKey]);
    expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
      credentialGeneration: pass.credentialGeneration,
      linkGeneration: pass.linkGeneration,
      downloadToken: pass.downloadToken,
      serial: pass.serial,
      authToken: pass.authToken,
      holderEmail: pass.holderEmail,
      objectKey: pass.objectKey,
    });
  }, 120_000);

  it('keeps a provider-backed transfer pending until retirement is durable, then resumes it', async () => {
    // Reuse the same KEK that issued the source pass and initialized the reference keyset.
    const kit = await setupKit({ template: makeProviderTestTemplate });
    const apple = await approveAppleRelease(kit);
    const pass = await kit.pass();
    const t = await setupSamsungCallbacks({ source: { kit, apple, pass, barcode: 'none' } });
    const result = await begin(kit, pass.id);
    expect(result.state).toBe('pending');
    const pending = await getPass(kit.env.DB, pass.id);
    expect(pending).toMatchObject({
      credentialGeneration: pass.credentialGeneration + 1,
      holderEmail: pass.holderEmail,
      serial: pass.serial,
      authToken: pass.authToken,
    });
    expect(await finishCredentialTransfer(jobCtxOf(kit), result.transferId)).toEqual(result);
    await resumePendingCredentialTransfers(jobCtxOf(kit));
    expect(await finishCredentialTransfer(jobCtxOf(kit), result.transferId)).toEqual(result);
    const scope = {
      orgId: pass.orgId,
      mode: pass.mode,
      provider: 'samsung' as const,
      instanceId: t.operation.instanceId,
    };
    const old = await getWalletInstanceById(kit.env.DB, scope);
    if (!old) throw new Error('Missing old provider instance');
    expect(await reconcileWalletInstance(jobCtxOf(kit), old)).toBe('scheduled');
    const retiring = await getWalletInstanceById(kit.env.DB, scope);
    if (!retiring) throw new Error('Missing retiring provider instance');
    const claim = {
      ...scope,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
      version: retiring.desiredVersion,
      claimHandle: newWalletClaimHandle(),
      now: kit.clock.now(),
    };
    expect(await claimWalletOperation(kit.env.DB, claim)).toBe('claimed');
    expect(
      await completeWalletOperation(jobCtxOf(kit), {
        ...claim,
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    expect(await finishWalletProviderRetirement(jobCtxOf(kit), claim)).toBe(true);
    await resumePendingCredentialTransfers(jobCtxOf(kit));
    expect(await finishCredentialTransfer(jobCtxOf(kit), result.transferId)).toEqual({
      transferId: result.transferId,
      state: 'completed',
    });
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.holderEmail).toBe(target.holderEmail);
    expect(after?.serial).not.toBe(pass.serial);
    expect(after?.scanCode).not.toBe(pass.scanCode);
  }, 120_000);

  it('encrypts a connector target and still completes it after the connection is edited', async () => {
    const kit = await setupKit();
    const original = await kit.pass({ memberName: 'Old private member' });
    const connectionId = kit.ctx.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO connections
      (id,org_id,connector_type,name,generation,created_at,updated_at) VALUES (?,?,'demo','source',1,?,?)`,
      [connectionId, original.orgId, kit.clock.now(), kit.clock.now()],
    );
    await run(
      kit.env.DB,
      `UPDATE passes SET connection_id = ?, external_ref = 'ref', sync_error_code = 'STALE'
      WHERE id = ?`,
      [connectionId, original.id],
    );
    const pass = await getPass(kit.env.DB, original.id);
    if (!pass) throw new Error('Missing connected pass');
    const expected = await source(kit, pass.id);
    const gate = uploadGate(kit, pass.id);
    try {
      const work = startCredentialTransfer(
        jobCtxOf(kit),
        { type: 'connection', id: connectionId },
        pass.id,
        target,
        null,
        {
          kind: 'connection',
          expected,
          connection: {
            passId: pass.id,
            orgId: pass.orgId,
            identityId: pass.identityId,
            mode: 'live',
            status: pass.status,
            expectedVersion: pass.version,
            ownerUserId: pass.ownerUserId,
            linkGeneration: pass.linkGeneration,
            credentialGeneration: pass.credentialGeneration,
            lifecycleGeneration: pass.lifecycleGeneration,
            credentialKeysetCommitment: await requireCredentialRefKeyset(kit.env.DB, kit.env),
            transferPending: false,
            connectionId,
            externalRef: 'ref',
            generation: 1,
            expectedConnectionMode: 'poll',
          },
          content: {
            personalization: { memberName: 'New private member' },
            fieldSources: { memberName: 'connection' },
          },
        },
      );
      await gate.arrived;
      const pending = await first<{ id: string }>(
        kit.env.DB,
        "SELECT id FROM pass_credential_transfers WHERE pass_id = ? AND state = 'pending'",
        [pass.id],
      );
      if (!pending) throw new Error('Missing pending transfer');
      const encrypted = await first<{ ciphertext: string }>(
        kit.env.DB,
        'SELECT hex(ciphertext) AS ciphertext FROM pass_credential_transfer_payloads WHERE transfer_id = ?',
        [pending.id],
      );
      const plaintext = Array.from(new TextEncoder().encode('New private member'), (byte) =>
        byte.toString(16).padStart(2, '0'),
      )
        .join('')
        .toUpperCase();
      expect(encrypted?.ciphertext).toBeTruthy();
      expect(encrypted?.ciphertext).not.toContain(plaintext);
      expect((await getPass(kit.env.DB, pass.id))?.personalization).toEqual(pass.personalization);
      // Editing the connection while the transfer is pending must not abort or wedge it (F11).
      await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [connectionId]);
      gate.release();
      expect(await work).toEqual({ transferId: pending.id, state: 'completed' });
      const after = await getPass(kit.env.DB, pass.id);
      expect(after).toMatchObject({
        holderEmail: target.holderEmail,
        personalization: { memberName: 'New private member' },
        fieldSources: { memberName: 'connection' },
        syncErrorCode: null,
      });
      expect(
        await first(
          kit.env.DB,
          'SELECT 1 FROM pass_credential_transfer_payloads WHERE transfer_id = ?',
          [pending.id],
        ),
      ).toBeNull();
    } finally {
      gate.release();
      gate.spy.mockRestore();
    }
  }, 120_000);

  it('does not commit or retain an artifact built under a superseded approved release', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const gate = uploadGate(kit, pass.id);
    try {
      const work = begin(kit, pass.id);
      await gate.arrived;
      const transfer = await first<{ id: string }>(
        kit.env.DB,
        "SELECT id FROM pass_credential_transfers WHERE pass_id = ? AND state = 'pending'",
        [pass.id],
      );
      if (!transfer) throw new Error('Missing pending transfer');
      const release = await approveAppleRelease(kit);
      gate.release();
      expect(await work).toEqual({ transferId: transfer.id, state: 'pending' });
      expect((await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects).toHaveLength(1);
      expect((await getPass(kit.env.DB, pass.id))?.serial).toBe(pass.serial);
      expect(await finishCredentialTransfer(jobCtxOf(kit), transfer.id)).toEqual({
        transferId: transfer.id,
        state: 'completed',
      });
      expect((await getPass(kit.env.DB, pass.id))?.releaseId).toBe(release.id);
    } finally {
      gate.release();
      gate.spy.mockRestore();
    }
  }, 120_000);

  it('leaves the transfer pending and deletes the losing artifact if the target owner loses eligibility', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const user = await makeUser(kit.fx);
    const expected = await source(kit, pass.id);
    const gate = uploadGate(kit, pass.id);
    try {
      const work = startCredentialTransfer(
        jobCtxOf(kit),
        system,
        pass.id,
        { holderEmail: user.primaryEmail, ownerUserId: user.id },
        null,
        { kind: 'tenant-holder', expected },
      );
      await gate.arrived;
      const reserved = await first<{ id: string; state: string }>(
        kit.env.DB,
        "SELECT id,state FROM pass_credential_transfers WHERE pass_id = ? AND state = 'pending'",
        [pass.id],
      );
      if (!reserved) throw new Error('Missing pending reservation');
      await run(kit.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
      gate.release();
      expect(await work).toEqual({ transferId: reserved.id, state: 'pending' });
      expect((await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects).toHaveLength(1);
      const held = await getPass(kit.env.DB, pass.id);
      expect(held).toMatchObject({
        serial: pass.serial,
        authToken: pass.authToken,
        ownerUserId: pass.ownerUserId,
      });
      await run(kit.env.DB, "UPDATE users SET status = 'active' WHERE id = ?", [user.id]);
      expect(await finishCredentialTransfer(jobCtxOf(kit), reserved.id)).toEqual({
        transferId: reserved.id,
        state: 'completed',
      });
      expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBe(user.id);
    } finally {
      gate.release();
      gate.spy.mockRestore();
    }
  }, 120_000);
});
