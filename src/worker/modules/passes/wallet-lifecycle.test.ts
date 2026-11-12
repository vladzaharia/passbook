import { describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { interveneAtD1 } from '../apple/credential-transfer-test-fixtures.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { codeOf, key, setupScanKit } from '../scan/test-kit.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  getWalletInstanceById,
  getWalletOperation,
  newWalletClaimHandle,
  readWalletPassSnapshot,
  retireWalletInstance,
} from '../wallet-providers/instance.ts';
import { onWalletPassUpdated, reconcileWalletInstance } from '../wallet-providers/lifecycle.ts';
import { makeProviderTestTemplate } from '../wallet-providers/offers-test-fixtures.ts';
import { runtimeGoogleLegacyFixture } from '../wallet-providers/runtime-integration-fixtures.ts';
import { drainWalletProviderSync } from '../wallet-providers/sync.ts';
import { finishWalletProviderRetirement } from '../wallet-providers/sync-operation-retirement.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { applyConnectionRecord } from './connection-passes.ts';
import { finishCredentialTransfer, startCredentialTransfer } from './credential-transfer.ts';
import { dailyPasses } from './jobs.ts';
import { ICON_PNG, setupKit, withKitDatabase } from './pass-test-fixtures.ts';
import { removePass, restorePass } from './remove.ts';
import { getPass } from './repo-read-pass.ts';
import { deletePass, updatePass } from './service.ts';

const actor = { type: 'system', id: null } as const;
const makeEnv = installKeysetTestEnv();
const testDatabase = async () => (await makeEnv()).DB;

describe.sequential('pass provider lifecycle', () => {
  it('durably stages update, removal and restore and rejects a stale revision notification', async () => {
    const t = await setupSamsungCallbacks({ db: await testDatabase() });
    const db = t.kit.env.DB;
    const scope = {
      orgId: t.pass.orgId,
      mode: t.pass.mode,
      provider: 'samsung' as const,
      instanceId: t.operation.instanceId,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    const before = await readWalletPassSnapshot(db, { ...scope, passId: t.pass.id });
    if (!before) throw new Error('Missing pass snapshot');
    const instance = async () => {
      const value = await getWalletInstanceById(db, scope);
      if (!value) throw new Error('Missing wallet instance');
      return value;
    };
    const currentOperation = async () => {
      const current = await instance();
      const op = await getWalletOperation(db, { ...scope, version: current.desiredVersion });
      if (!op) throw new Error('Missing desired operation');
      return op;
    };

    await updatePass(
      jobCtxOf(t.kit),
      actor,
      t.pass.id,
      { input: { memberName: 'Updated Member' } },
      { scope: null },
    );
    expect(
      await first(
        db,
        'SELECT instance_id FROM wallet_provider_instance_dirty WHERE instance_id = ?',
        [scope.instanceId],
      ),
    ).not.toBeNull();
    expect(
      await onWalletPassUpdated(jobCtxOf(t.kit), {
        orgId: scope.orgId,
        mode: scope.mode,
        passId: t.pass.id,
        passVersion: before.passVersion,
        passRevision: before.passRevision,
        passCredentialGeneration: before.credentialGeneration,
        credentialKeysetCommitment: before.credentialKeysetCommitment,
        lifecycleGeneration: before.lifecycleGeneration,
      }),
    ).toMatchObject({ stale: true, scheduled: 0 });
    expect(await reconcileWalletInstance(jobCtxOf(t.kit), await instance())).toBe('scheduled');
    const changed = await readWalletPassSnapshot(db, { ...scope, passId: t.pass.id });
    expect(await currentOperation()).toMatchObject({
      kind: 'upsert',
      passVersion: changed?.passVersion,
      passRevision: changed?.passRevision,
    });

    await removePass(jobCtxOf(t.kit), actor, t.pass.id, {}, null);
    expect(await reconcileWalletInstance(jobCtxOf(t.kit), await instance())).toBe('scheduled');
    const revoked = await currentOperation();
    expect(revoked).toMatchObject({ kind: 'revoke', state: 'pending' });
    expect((await instance()).retirementRequestedAt).toBeNull();

    await restorePass(jobCtxOf(t.kit), actor, t.pass.id, null);
    expect(await reconcileWalletInstance(jobCtxOf(t.kit), await instance())).toBe('scheduled');
    const restored = await currentOperation();
    expect(restored).toMatchObject({ kind: 'upsert', state: 'pending' });
    expect(restored.lifecycleGeneration).toBeGreaterThan(revoked.lifecycleGeneration);
    expect((await instance()).retirementRequestedAt).toBeNull();
    expect((await instance()).installationState).toBe('unknown');
  }, 120_000);

  it('keeps a deleted Apple pass until the accepted provider revoke has a durable Samsung tombstone', async () => {
    const scanKit = await withKitDatabase(await testDatabase(), setupScanKit);
    const templateId = `tpl-provider-retention-${scanKit.fx.ids.token(4)}`;
    const { resolved: base } = makeProviderTestTemplate(templateId);
    const template = scanKit.registry.add({
      id: templateId,
      orgId: scanKit.org.id,
      manifest: {
        ...base.manifest,
        name: 'Provider retention',
        bindings: [
          ...base.manifest.bindings,
          { to: { barcode: 0, prop: 'message' }, value: '{{pass.scanCode}}' },
        ],
        scan: { actions: [{ id: 'entry', label: 'Enter', kind: 'check_in' }] },
      },
      passJson: {
        ...base.passJson,
        barcodes: [{ format: 'PKBarcodeFormatQR', message: 'x', messageEncoding: 'utf-8' }],
      },
      assets: { 'icon.png': ICON_PNG },
    });
    // The registry's default "other" slot must describe the actual reviewed icon.
    const icon = template.assets.find((asset) => asset.name === 'icon.png');
    if (!icon) throw new Error('Missing provider retention icon.');
    icon.slot = 'icon';
    await persistTemplate(scanKit.fx, template, { registry: scanKit.registry });
    await approveAppleRelease(scanKit, { templateId, version: template.version });
    await approveAppleRelease(scanKit, { templateId, version: template.version, mode: 'test' });
    const apple = await approveAppleRelease(scanKit, { templateId, version: template.version });
    const pass = await scanKit.scanPass(
      templateId,
      { memberName: 'Private Holder' },
      {
        holderEmail: 'private@example.test',
      },
    );
    const t = await setupSamsungCallbacks({
      source: { kit: { ...scanKit, template }, apple, pass, barcode: 'qr' },
    });
    const event = await scanKit.event({ templateIds: [templateId] });
    const scanner = await scanKit.scanner({ eventId: event.id, templateIds: [templateId] });
    const scan = await scanKit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: scanKit.clock.now(),
      actionId: 'entry',
    });
    expect(scan.status).toBe(200);
    const outcome = (await scan.json()) as { kind: string; scanId: string };
    expect(outcome.kind).toBe('ok');
    const proof = await first<{ pass_ref: string }>(
      scanKit.env.DB,
      'SELECT pass_ref FROM scan_retention_proofs WHERE scan_id = ?',
      [outcome.scanId],
    );
    if (!proof) throw new Error('Missing scan retention proof');
    const db = t.kit.env.DB;
    const scope = {
      orgId: t.pass.orgId,
      mode: t.pass.mode,
      provider: 'samsung' as const,
      instanceId: t.operation.instanceId,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    await t.kit.device(t.pass, 'wallet-retention-device', 'device-token');
    await deletePass(jobCtxOf(t.kit), actor, t.pass.id, null);
    const deleted = await first<{ object_key: string; deleted_at: number | null }>(
      db,
      'SELECT object_key, deleted_at FROM passes WHERE id = ?',
      [t.pass.id],
    );
    if (!deleted?.deleted_at) throw new Error('Pass was not soft-deleted');
    t.kit.clock.advance(8 * 86_400_000);
    await dailyPasses(jobCtxOf(t.kit));
    expect(await first(db, 'SELECT id FROM passes WHERE id = ?', [t.pass.id])).not.toBeNull();
    expect(
      await first(db, 'SELECT 1 FROM registrations WHERE pass_id = ?', [t.pass.id]),
    ).not.toBeNull();
    expect(await t.kit.env.BUCKET.head(deleted.object_key)).not.toBeNull();
    expect(await first(db, 'SELECT pass_id FROM scans WHERE id = ?', [outcome.scanId])).toEqual({
      pass_id: t.pass.id,
    });
    expect(
      await first(db, 'SELECT 1 FROM scan_retained_gates WHERE scan_id = ?', [outcome.scanId]),
    ).toBeNull();

    const old = await getWalletInstanceById(db, scope);
    if (!old) throw new Error('Missing provider instance');
    expect(await reconcileWalletInstance(jobCtxOf(t.kit), old)).toBe('scheduled');
    const retiring = await getWalletInstanceById(db, scope);
    if (!retiring) throw new Error('Missing retirement operation');
    const claim = {
      ...scope,
      version: retiring.desiredVersion,
      claimHandle: newWalletClaimHandle(),
      now: t.kit.clock.now(),
    };
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    expect(
      await completeWalletOperation(jobCtxOf(t.kit), {
        ...claim,
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    await dailyPasses(jobCtxOf(t.kit));
    expect(await first(db, 'SELECT id FROM passes WHERE id = ?', [t.pass.id])).not.toBeNull();
    expect(await t.kit.env.BUCKET.head(deleted.object_key)).not.toBeNull();
    expect(await finishWalletProviderRetirement(jobCtxOf(t.kit), claim)).toBe(true);
    const tombstone = await first<Record<string, unknown>>(
      db,
      'SELECT * FROM wallet_samsung_tombstones WHERE ref_hash = ?',
      [await sha256Hex(t.refId)],
    );
    expect(tombstone).not.toBeNull();
    expect(JSON.stringify(tombstone)).not.toContain(t.pass.id);
    await dailyPasses(jobCtxOf(t.kit));
    expect(await first(db, 'SELECT id FROM passes WHERE id = ?', [t.pass.id])).toBeNull();
    expect(
      await first(db, 'SELECT 1 FROM registrations WHERE pass_id = ?', [t.pass.id]),
    ).toBeNull();
    expect(await t.kit.env.BUCKET.head(deleted.object_key)).toBeNull();
    expect(await first(db, 'SELECT pass_id FROM scans WHERE id = ?', [outcome.scanId])).toEqual({
      pass_id: null,
    });
    const gate = await first<Record<string, unknown>>(
      db,
      'SELECT * FROM scan_retained_gates WHERE scan_id = ?',
      [outcome.scanId],
    );
    expect(gate).toMatchObject({
      scan_id: outcome.scanId,
      org_id: t.pass.orgId,
      mode: t.pass.mode,
      event_id: event.id,
      pass_ref: proof.pass_ref,
    });
    expect(JSON.stringify(gate)).not.toContain(t.pass.id);
    expect(JSON.stringify(gate)).not.toContain('private@example.test');
  }, 120_000);

  it('keeps a deleted Apple pass after a historical Google revoke while replay safety is unknown', async () => {
    const t = await runtimeGoogleLegacyFixture({ db: await testDatabase() });
    const db = t.kit.env.DB;
    const ref = {
      orgId: t.pass.orgId,
      mode: t.pass.mode,
      provider: 'google' as const,
      instanceId: t.instanceId,
      version: 1,
      credentialKeysetCommitment: t.scope.credentialKeysetCommitment,
    };
    expect(
      await completeWalletOperation(jobCtxOf(t.kit), {
        ...ref,
        claimHandle: t.claimHandle,
        now: t.kit.clock.now(),
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    expect(await getWalletInstanceById(db, ref)).toMatchObject({
      lifecycle: 'revoked',
      installationState: 'unknown',
    });
    expect(await retireWalletInstance(db, { ...ref, now: t.kit.clock.now() })).toBe(false);
    await t.kit.device(t.pass, 'google-retention-device', 'device-token');
    await deletePass(jobCtxOf(t.kit), actor, t.pass.id, null);
    const deleted = await first<{ object_key: string }>(
      db,
      'SELECT object_key FROM passes WHERE id = ?',
      [t.pass.id],
    );
    if (!deleted) throw new Error('Pass was not soft-deleted');
    t.kit.clock.advance(8 * 86_400_000);
    await dailyPasses(jobCtxOf(t.kit));
    expect(await first(db, 'SELECT id FROM passes WHERE id = ?', [t.pass.id])).not.toBeNull();
    expect(
      await first(db, 'SELECT 1 FROM registrations WHERE pass_id = ?', [t.pass.id]),
    ).not.toBeNull();
    expect(await t.kit.env.BUCKET.head(deleted.object_key)).not.toBeNull();
  }, 120_000);

  it('reconciles unissued target placeholders before ordinary deleted-pass retention', async () => {
    const kit = await setupKit({ db: await testDatabase() });
    const pass = await kit.pass({ holderEmail: 'before@example.test' });
    const expected = await getHolderPass(kit.env.DB, pass.id, null);
    if (!expected) throw new Error('Missing holder snapshot');
    expect(
      await startCredentialTransfer(
        jobCtxOf(kit),
        actor,
        pass.id,
        { holderEmail: 'after@example.test', ownerUserId: null },
        null,
        { kind: 'tenant-holder', expected },
      ),
    ).toMatchObject({ state: 'completed' });
    await deletePass(jobCtxOf(kit), actor, pass.id, null);
    const deleted = await first<{ object_key: string }>(
      kit.env.DB,
      'SELECT object_key FROM passes WHERE id = ?',
      [pass.id],
    );
    if (!deleted) throw new Error('Pass was not soft-deleted');
    kit.clock.advance(8 * 86_400_000);
    await dailyPasses(jobCtxOf(kit));
    expect(await first(kit.env.DB, 'SELECT id FROM passes WHERE id = ?', [pass.id])).not.toBeNull();
    expect(await kit.env.BUCKET.head(deleted.object_key)).not.toBeNull();
    await drainWalletProviderSync(jobCtxOf(kit));
    expect(
      await first(
        kit.env.DB,
        `SELECT COUNT(*) AS n FROM wallet_provider_instances
      WHERE pass_id = ? AND lifecycle = 'retired' AND retirement_reason = 'not_issued'`,
        [pass.id],
      ),
    ).toEqual({ n: 2 });
    await dailyPasses(jobCtxOf(kit));
    expect(await first(kit.env.DB, 'SELECT id FROM passes WHERE id = ?', [pass.id])).toBeNull();
    expect(await kit.env.BUCKET.head(deleted.object_key)).toBeNull();
  }, 120_000);

  it.each(['metadata', 'artifact'] as const)(
    'defers connection holder and content until the old provider retires (%s)',
    async (kind) => {
      const t = await setupSamsungCallbacks({ db: await testDatabase() });
      const db = t.kit.env.DB;
      const connectionId = t.kit.fx.ids.id();
      await run(
        db,
        `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
        VALUES (?, ?, 'demo', 'wallet holder sync', 1, 1, 1)`,
        [connectionId, t.pass.orgId],
      );
      await run(
        db,
        "UPDATE passes SET connection_id = ?, external_ref = 'ref', field_sources = '{}' WHERE id = ?",
        [connectionId, t.pass.id],
      );
      const pass = await getPass(db, t.pass.id);
      if (!pass) throw new Error('Missing linked pass');
      await expect(
        applyConnectionRecord(jobCtxOf(t.kit), {
          passId: pass.id,
          orgId: pass.orgId,
          mode: 'live',
          status: 'active',
          expectedVersion: pass.version,
          ownerUserId: pass.ownerUserId,
          linkGeneration: pass.linkGeneration,
          connectionId,
          identityId: pass.identityId,
          credentialGeneration: pass.credentialGeneration,
          lifecycleGeneration: pass.lifecycleGeneration,
          credentialKeysetCommitment: t.credentialKeysetCommitment,
          transferPending: false,
          externalRef: 'ref',
          generation: 1,
          expectedConnectionMode: 'poll',
          holderEmail: 'new@example.test',
          fields: kind === 'artifact' ? { memberName: 'New Member' } : {},
          cause: 'connection',
        }),
      ).rejects.toMatchObject({ code: 'CONNECTION_TRANSFER_PENDING' });
      const pending = await first<{ id: string }>(
        db,
        "SELECT id FROM pass_credential_transfers WHERE pass_id = ? AND state = 'pending'",
        [pass.id],
      );
      if (!pending) throw new Error('Missing durable transfer');
      const payload = await first<{ ciphertext: ArrayBuffer }>(
        db,
        'SELECT ciphertext FROM pass_credential_transfer_payloads WHERE transfer_id = ?',
        [pending.id],
      );
      if (!payload) throw new Error('Missing encrypted transfer payload');
      expect(new TextDecoder().decode(new Uint8Array(payload.ciphertext))).not.toContain(
        'New Member',
      );
      expect(await getPass(db, pass.id)).toMatchObject({
        holderEmail: pass.holderEmail,
        ownerUserId: pass.ownerUserId,
        version: pass.version,
        serial: pass.serial,
        authToken: pass.authToken,
        scanCode: pass.scanCode,
        personalization: pass.personalization,
        credentialGeneration: pass.credentialGeneration + 1,
        linkGeneration: pass.linkGeneration + 1,
      });
      expect(await finishCredentialTransfer(jobCtxOf(t.kit), pending.id)).toMatchObject({
        state: 'pending',
      });
      expect(
        await first(
          db,
          'SELECT retirement_requested_at FROM wallet_provider_instances WHERE id = ?',
          [t.operation.instanceId],
        ),
      ).toEqual({ retirement_requested_at: t.kit.clock.now() });
      expect(
        await first(
          db,
          'SELECT instance_id FROM wallet_provider_instance_dirty WHERE instance_id = ?',
          [t.operation.instanceId],
        ),
      ).not.toBeNull();
      expect((await t.call({ token: await t.token() })).status).not.toBe(200);

      const scope = {
        orgId: pass.orgId,
        mode: pass.mode,
        provider: 'samsung' as const,
        instanceId: t.operation.instanceId,
        credentialKeysetCommitment: t.credentialKeysetCommitment,
      };
      const instance = await getWalletInstanceById(db, scope);
      if (!instance) throw new Error('Missing wallet instance');
      expect(await reconcileWalletInstance(jobCtxOf(t.kit), instance)).toBe('scheduled');
      const retiring = await getWalletInstanceById(db, scope);
      if (!retiring) throw new Error('Missing retiring wallet instance');
      const claim = {
        ...scope,
        version: retiring.desiredVersion,
        claimHandle: newWalletClaimHandle(),
        now: t.kit.clock.now(),
      };
      expect(await claimWalletOperation(db, claim)).toBe('claimed');
      expect(
        await completeWalletOperation(jobCtxOf(t.kit), {
          ...claim,
          result: { kind: 'success', httpStatus: 200 },
        }),
      ).toBe('succeeded');
      expect(await finishWalletProviderRetirement(jobCtxOf(t.kit), claim)).toBe(true);
      expect(await finishCredentialTransfer(jobCtxOf(t.kit), pending.id)).toMatchObject({
        state: 'completed',
      });
      expect(
        await first(
          db,
          'SELECT transfer_id FROM pass_credential_transfer_payloads WHERE transfer_id = ?',
          [pending.id],
        ),
      ).toBeNull();
      const changed = await getPass(db, pass.id);
      expect(changed).toMatchObject({
        holderEmail: 'new@example.test',
        version: pass.version + 1,
        linkGeneration: pass.linkGeneration + 1,
        credentialGeneration: pass.credentialGeneration + 1,
        personalization:
          kind === 'artifact'
            ? { ...pass.personalization, memberName: 'New Member' }
            : pass.personalization,
      });
      expect(changed?.serial).not.toBe(pass.serial);
      expect(changed?.authToken).not.toBe(pass.authToken);
      expect(changed?.scanCode).not.toBe(pass.scanCode);
      expect(await finishCredentialTransfer(jobCtxOf(t.kit), pending.id)).toMatchObject({
        state: 'completed',
      });
    },
    120_000,
  );
  it('does not stage provider retirement when the connection CAS loses', async () => {
    const t = await setupSamsungCallbacks({ db: await testDatabase() });
    const db = t.kit.env.DB;
    const connectionId = t.kit.fx.ids.id();
    await run(
      db,
      `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
      VALUES (?, ?, 'demo', 'wallet race', 1, 1, 1)`,
      [connectionId, t.pass.orgId],
    );
    await run(
      db,
      "UPDATE passes SET connection_id = ?, external_ref = 'ref', field_sources = '{}' WHERE id = ?",
      [connectionId, t.pass.id],
    );
    const pass = await getPass(db, t.pass.id);
    if (!pass) throw new Error('Missing linked pass');
    const seam = interveneAtD1(
      db,
      { method: 'batch', sql: /INSERT INTO pass_credential_transfers\b/, when: 'before' },
      async () => {
        const changed = await run(
          db,
          'UPDATE connections SET generation = generation + 1 WHERE id = ?',
          [connectionId],
        );
        expect(changed.changes).toBe(1);
      },
    );
    const raced = { ...jobCtxOf(t.kit), env: { ...t.kit.env, DB: seam.db } };
    await expect(
      applyConnectionRecord(raced, {
        passId: pass.id,
        orgId: pass.orgId,
        mode: 'live',
        status: 'active',
        expectedVersion: pass.version,
        ownerUserId: pass.ownerUserId,
        linkGeneration: pass.linkGeneration,
        connectionId,
        identityId: pass.identityId,
        credentialGeneration: pass.credentialGeneration,
        lifecycleGeneration: pass.lifecycleGeneration,
        credentialKeysetCommitment: t.credentialKeysetCommitment,
        transferPending: false,
        externalRef: 'ref',
        generation: 1,
        expectedConnectionMode: 'poll',
        holderEmail: 'stale@example.test',
        fields: {},
        cause: 'connection',
      }),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    expect(seam.hits()).toBe(1);
    expect(
      await first(
        db,
        'SELECT retirement_requested_at FROM wallet_provider_instances WHERE id = ?',
        [t.operation.instanceId],
      ),
    ).toEqual({ retirement_requested_at: null });
    expect(await getPass(db, pass.id)).toMatchObject({
      holderEmail: pass.holderEmail,
      downloadToken: pass.downloadToken,
      version: pass.version,
      linkGeneration: pass.linkGeneration,
    });
  }, 120_000);
});
