import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { beginTransfer, interveneAtD1 } from '../apple/credential-transfer-test-fixtures.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { bindPassConnection } from './connection-bind.ts';
import { applyConnectionRecord, markPassMissing } from './connection-passes.ts';
import { requireCredentialRefKeyset } from './credential-keyset.ts';
import { overrideDeps } from './deps.ts';
import { requestRefresh } from './pass-service-refresh.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';
import { listPasses, setBinding } from './repo.ts';
import { getPass, getPassByDownloadToken, getPassBySerial } from './repo-read-pass.ts';
import { updatePass } from './service.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

async function linked(mode: 'live' | 'test' = 'live', orgId = kit.org.id) {
  const pass = await kit.pass({ mode, orgId });
  const connectionId = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
     VALUES (?, ?, 'demo', 'race', 1, 1, 1)`,
    [connectionId, pass.orgId],
  );
  await run(
    kit.env.DB,
    "UPDATE passes SET connection_id = ?, external_ref = 'ref', field_sources = '{}' WHERE id = ?",
    [connectionId, pass.id],
  );
  const current = await getPass(kit.env.DB, pass.id);
  if (!current) throw new Error('Missing fixture pass');
  const credentialKeysetCommitment = await requireCredentialRefKeyset(kit.env.DB, kit.env);
  return {
    pass: current,
    context: {
      passId: current.id,
      orgId: current.orgId,
      mode: 'live' as const,
      status: 'active' as const,
      expectedVersion: current.version,
      ownerUserId: current.ownerUserId,
      linkGeneration: current.linkGeneration,
      identityId: current.identityId,
      credentialGeneration: current.credentialGeneration,
      lifecycleGeneration: current.lifecycleGeneration,
      credentialKeysetCommitment,
      transferPending: false,
      connectionId,
      externalRef: 'ref',
      generation: 1,
      expectedConnectionMode: 'poll' as const,
    },
  };
}

const persisted = (id: string) =>
  first(
    kit.env.DB,
    `SELECT org_id, identity_id, mode, status, version, connection_id, external_ref, deleted_at, removed_at,
    test_data_quarantined, owner_user_id, holder_email, link_generation, credential_generation,
    lifecycle_generation, download_token,
    personalization, field_sources, object_key, sync_error_code FROM passes WHERE id = ?`,
    [id],
  );

describe('connector snapshot fencing', () => {
  it.each([
    'version',
    'status',
    'removed',
    'deleted',
    'quarantine',
    'lifecycle-aba',
    'reference',
    'unbound',
    'generation',
    'connection-mode',
    'disabled',
    'connection-org',
    'org-status',
    'holder',
  ] as const)(
    'loses the final publish CAS after a %s change without keeping the new object',
    async (change) => {
      const { pass, context } = await linked();
      const otherOrg = await makeOrg(kit.fx, { name: `Other ${kit.fx.ids.token(4)}` });
      let raced: unknown;
      let raceStarted = false;
      let staleKey = '';
      const put = kit.env.BUCKET.put.bind(kit.env.BUCKET);
      const spy = vi
        .spyOn(kit.env.BUCKET, 'put')
        .mockImplementation(async (key, value, options) => {
          const object = await put(key, value, options);
          if (key.startsWith(`passes/${pass.id}/`) && !raceStarted) {
            raceStarted = true;
            staleKey = key;
            switch (change) {
              case 'version':
                await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [
                  pass.id,
                ]);
                break;
              case 'status':
                await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [
                  pass.id,
                ]);
                break;
              case 'removed':
                await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [pass.id]);
                break;
              case 'deleted':
                await run(kit.env.DB, 'UPDATE passes SET deleted_at = 1 WHERE id = ?', [pass.id]);
                break;
              case 'quarantine':
                await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
                  pass.id,
                ]);
                break;
              case 'lifecycle-aba':
                await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [pass.id]);
                await run(kit.env.DB, 'UPDATE passes SET removed_at = NULL WHERE id = ?', [
                  pass.id,
                ]);
                break;
              case 'reference':
                await run(kit.env.DB, "UPDATE passes SET external_ref = 'other' WHERE id = ?", [
                  pass.id,
                ]);
                break;
              case 'unbound':
                await run(
                  kit.env.DB,
                  'UPDATE passes SET connection_id = NULL, external_ref = NULL WHERE id = ?',
                  [pass.id],
                );
                break;
              case 'generation':
                await run(
                  kit.env.DB,
                  'UPDATE connections SET generation = generation + 1 WHERE id = ?',
                  [context.connectionId],
                );
                break;
              case 'connection-mode':
                await run(kit.env.DB, "UPDATE connections SET mode = 'webhook' WHERE id = ?", [
                  context.connectionId,
                ]);
                break;
              case 'disabled':
                await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [
                  context.connectionId,
                ]);
                break;
              case 'connection-org':
                await run(kit.env.DB, 'UPDATE connections SET org_id = ? WHERE id = ?', [
                  otherOrg.id,
                  context.connectionId,
                ]);
                break;
              case 'org-status':
                await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [
                  pass.orgId,
                ]);
                break;
              case 'holder':
                expect((await beginTransfer(kit, pass)).state).toBe('completed');
                break;
            }
            raced = await persisted(pass.id);
          }
          return object;
        });
      try {
        await expect(
          applyConnectionRecord(jobCtxOf(kit), {
            ...context,
            fields: { memberName: 'Stale' },
            cause: 'connection',
          }),
        ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
        expect(await persisted(pass.id)).toEqual(raced);
        expect(staleKey).not.toBe('');
        expect(
          (await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects.map((o) => o.key),
        ).not.toContain(staleKey);
      } finally {
        spy.mockRestore();
        if (change === 'org-status')
          await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [pass.orgId]);
      }
    },
  );

  it.each(['test mode', 'foreign organization'] as const)(
    'rejects a pass initially in %s rather than changing an immutable scope',
    async (kind) => {
      const other = await makeOrg(kit.fx, { name: `Foreign ${kit.fx.ids.token(4)}` });
      const { pass, context } = await linked(
        kind === 'test mode' ? 'test' : 'live',
        kind === 'foreign organization' ? other.id : kit.org.id,
      );
      const supplied =
        kind === 'foreign organization' ? { ...context, orgId: kit.org.id } : context;
      const before = await persisted(pass.id);
      const put = vi.spyOn(kit.env.BUCKET, 'put');
      try {
        await expect(
          applyConnectionRecord(jobCtxOf(kit), {
            ...supplied,
            fields: { memberName: 'Stale' },
            cause: 'connection',
          }),
        ).rejects.toMatchObject({ code: 'PASS_CONNECTION_MISMATCH' });
        expect(await persisted(pass.id)).toEqual(before);
        expect(put).not.toHaveBeenCalled();
      } finally {
        put.mockRestore();
      }
    },
  );

  it('rejects malformed or mismatched connector epochs and retained bindings before publication', async () => {
    const { pass, context } = await linked();
    const before = await persisted(pass.id);
    const put = vi.spyOn(kit.env.BUCKET, 'put');
    try {
      for (const invalid of [
        { identityId: undefined },
        { identityId: 'other-identity' },
        { credentialGeneration: undefined },
        { credentialGeneration: context.credentialGeneration + 1 },
        { lifecycleGeneration: undefined },
        { lifecycleGeneration: context.lifecycleGeneration + 1 },
        { credentialKeysetCommitment: undefined },
        {
          credentialKeysetCommitment:
            context.credentialKeysetCommitment === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64),
        },
        { transferPending: undefined },
        { transferPending: true },
        { expectedConnectionMode: undefined },
        { expectedConnectionMode: 'webhook' },
        {
          retainedBinding: {
            templateId: 'other-template',
            releaseId: pass.releaseId,
            templateVersion: pass.templateVersion,
            credentialKeysetCommitment: context.credentialKeysetCommitment,
          },
        },
      ]) {
        await expect(
          applyConnectionRecord(jobCtxOf(kit), {
            ...context,
            ...invalid,
            fields: { memberName: 'Stale' },
            cause: 'connection',
          } as never),
        ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      }
      expect(await persisted(pass.id)).toEqual(before);
      expect(put).not.toHaveBeenCalled();
    } finally {
      put.mockRestore();
    }
  });

  it('forbids changing scope, identity, holder or credential generation outside a transfer', async () => {
    const { pass } = await linked();
    const other = await makeOrg(kit.fx, { name: `Foreign ${kit.fx.ids.token(4)}` });
    const before = await persisted(pass.id);
    for (const change of [
      { sql: "UPDATE passes SET mode = 'test' WHERE id = ?", params: [pass.id] },
      { sql: 'UPDATE passes SET org_id = ? WHERE id = ?', params: [other.id, pass.id] },
      {
        sql: 'UPDATE passes SET identity_id = ? WHERE id = ?',
        params: ['other-identity', pass.id],
      },
      {
        sql: 'UPDATE passes SET holder_email = ? WHERE id = ?',
        params: ['other@example.test', pass.id],
      },
      {
        sql: 'UPDATE passes SET credential_generation = credential_generation + 1 WHERE id = ?',
        params: [pass.id],
      },
    ]) {
      await expect(run(kit.env.DB, change.sql, change.params)).rejects.toThrow();
      expect(await persisted(pass.id)).toEqual(before);
    }
  });

  it('transfers the holder and revokes old bundle links even when the mapped fields are unchanged', async () => {
    const { pass, context } = await linked();
    const bundleId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      "INSERT INTO bundles (id, org_id, name, token, created_at) VALUES (?, ?, 'B', ?, 1)",
      [bundleId, pass.orgId, kit.fx.ids.token()],
    );
    await run(
      kit.env.DB,
      'INSERT INTO bundle_passes (bundle_id, pass_id, position) VALUES (?, ?, 0)',
      [bundleId, pass.id],
    );
    const result = await applyConnectionRecord(jobCtxOf(kit), {
      ...context,
      fields: {},
      holderEmail: 'new@example.test',
      cause: 'connection',
    });
    const updated = await getPass(kit.env.DB, pass.id);
    expect(result).toMatchObject({
      changed: true,
      version: pass.version + 1,
      linkGeneration: pass.linkGeneration + 1,
    });
    expect(updated?.holderEmail).toBe('new@example.test');
    expect(updated?.downloadToken).not.toBe(pass.downloadToken);
    expect(updated?.credentialGeneration).toBe(pass.credentialGeneration + 1);
    expect(updated?.serial).not.toBe(pass.serial);
    expect(updated?.authToken).not.toBe(pass.authToken);
    expect(updated?.scanCode).not.toBe(pass.scanCode);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM bundle_passes WHERE bundle_id = ? AND pass_id = ?', [
        bundleId,
        pass.id,
      ]),
    ).toBeNull();
  });

  it('does not change holder, sync error, or bundle membership when metadata CAS is stale', async () => {
    const { pass, context } = await linked();
    const bundleId = kit.fx.ids.id();
    await run(
      kit.env.DB,
      "INSERT INTO bundles (id, org_id, name, token, created_at) VALUES (?, ?, 'B', ?, 1)",
      [bundleId, pass.orgId, kit.fx.ids.token()],
    );
    await run(
      kit.env.DB,
      'INSERT INTO bundle_passes (bundle_id, pass_id, position) VALUES (?, ?, 0)',
      [bundleId, pass.id],
    );
    // The connection is edited right before the transfer reservation commits.
    const seam = interveneAtD1(
      kit.env.DB,
      { method: 'batch', sql: /INSERT INTO pass_credential_transfers\b/, when: 'before' },
      async () => {
        await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
          context.connectionId,
        ]);
      },
    );
    try {
      await expect(
        applyConnectionRecord(
          { ...jobCtxOf(kit), env: { ...kit.env, DB: seam.db } },
          {
            ...context,
            fields: {},
            holderEmail: 'stale@example.test',
            cause: 'connection',
          },
        ),
      ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      expect(seam.hits()).toBe(1);
      expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
        version: pass.version,
        holderEmail: pass.holderEmail,
        downloadToken: pass.downloadToken,
        linkGeneration: pass.linkGeneration,
        syncErrorCode: null,
      });
      expect(
        await first(
          kit.env.DB,
          'SELECT 1 AS ok FROM bundle_passes WHERE bundle_id = ? AND pass_id = ?',
          [bundleId, pass.id],
        ),
      ).toEqual({ ok: 1 });
    } finally {
      expect(seam.hits()).toBeLessThanOrEqual(1);
    }
  });

  it('revalidates connection generation before writing a built artifact to R2', async () => {
    const { pass, context } = await linked();
    const put = vi.spyOn(kit.env.BUCKET, 'put');
    overrideDeps(kit.env, {
      registry: {
        list: (q) => kit.registry.list(q),
        openAsset: (t, n) => kit.registry.openAsset(t, n),
        async resolve(id, version) {
          await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
            context.connectionId,
          ]);
          return kit.registry.resolve(id, version);
        },
      },
    });
    try {
      await expect(
        applyConnectionRecord(jobCtxOf(kit), {
          ...context,
          fields: { memberName: 'Stale' },
          cause: 'connection',
        }),
      ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      expect(put).not.toHaveBeenCalled();
      expect((await getPass(kit.env.DB, pass.id))?.version).toBe(pass.version);
    } finally {
      put.mockRestore();
      overrideDeps(kit.env, { registry: kit.registry });
    }
  });

  it('rejects a missing record from an obsolete binding without changing sync state', async () => {
    const { pass, context } = await linked();
    await run(kit.env.DB, "UPDATE passes SET external_ref = 'other' WHERE id = ?", [pass.id]);
    await expect(markPassMissing(jobCtxOf(kit), context, 'flag')).rejects.toMatchObject({
      code: 'PASS_CONNECTION_MISMATCH',
    });
    expect((await getPass(kit.env.DB, pass.id))?.syncErrorCode).toBeNull();
  });

  it('does not bind over a version changed after selection', async () => {
    const { pass, context } = await linked();
    await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]);
    expect(
      await setBinding(jobCtxOf(kit), pass, {
        connectionId: context.connectionId,
        externalRef: 'new-ref',
        fieldSources: {},
        generation: 1,
        connectionMode: 'poll',
      }),
    ).toBe(false);
    expect((await getPass(kit.env.DB, pass.id))?.externalRef).toBe('ref');
  });

  it.each(['generation', 'mode', 'disabled', 'organization'] as const)(
    'does not bind after the target connection changes %s',
    async (change) => {
      const { pass, context } = await linked();
      const before = await persisted(pass.id);
      if (change === 'generation')
        await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
          context.connectionId,
        ]);
      else if (change === 'mode')
        await run(kit.env.DB, "UPDATE connections SET mode = 'webhook' WHERE id = ?", [
          context.connectionId,
        ]);
      else if (change === 'disabled')
        await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [
          context.connectionId,
        ]);
      else {
        const org = await makeOrg(kit.fx, { name: `Other ${kit.fx.ids.token(4)}` });
        await run(kit.env.DB, 'UPDATE connections SET org_id = ? WHERE id = ?', [
          org.id,
          context.connectionId,
        ]);
      }
      expect(
        await setBinding(jobCtxOf(kit), pass, {
          connectionId: context.connectionId,
          externalRef: 'new-ref',
          fieldSources: {},
          generation: 1,
          connectionMode: 'poll',
        }),
      ).toBe(false);
      expect(await persisted(pass.id)).toEqual(before);
    },
  );

  it.each(['version', 'status', 'removed', 'deleted', 'quarantine', 'reference'] as const)(
    'does not unbind after the selected pass changes %s',
    async (change) => {
      const { pass } = await linked();
      if (change === 'version')
        await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]);
      else if (change === 'status')
        await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
      else if (change === 'removed')
        await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [pass.id]);
      else if (change === 'deleted')
        await run(kit.env.DB, 'UPDATE passes SET deleted_at = 1 WHERE id = ?', [pass.id]);
      else if (change === 'quarantine')
        await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
          pass.id,
        ]);
      else
        await run(kit.env.DB, "UPDATE passes SET external_ref = 'other' WHERE id = ?", [pass.id]);
      const afterRace = await persisted(pass.id);
      expect(
        await setBinding(jobCtxOf(kit), pass, {
          connectionId: null,
          externalRef: null,
          fieldSources: pass.fieldSources,
          generation: null,
          connectionMode: null,
        }),
      ).toBe(false);
      expect(await persisted(pass.id)).toEqual(afterRace);
    },
  );

  it.each(['test', 'disabled'] as const)(
    'does not apply a reset-to-connection patch with a %s binding',
    async (change) => {
      const { pass, context } = await linked(change === 'test' ? 'test' : 'live');
      if (change === 'disabled')
        await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [
          context.connectionId,
        ]);
      const before = await persisted(pass.id);
      await expect(
        updatePass(
          jobCtxOf(kit),
          { type: 'user', id: 'u1' },
          pass.id,
          { input: { memberName: 'Must not be saved' }, resetToConnection: ['memberName'] },
          { scope: null },
        ),
      ).rejects.toMatchObject({ code: change === 'test' ? 'MODE_MISMATCH' : 'PASS_CONFLICT' });
      expect(await persisted(pass.id)).toEqual(before);
      expect((await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects).toHaveLength(1);
    },
  );

  it('keeps unbound Test refreshes and fences unsafe legacy Test unbinding', async () => {
    const unbound = await kit.pass({ mode: 'test' });
    const testPass = await getPass(kit.env.DB, unbound.id);
    if (!testPass) throw new Error('Missing Test fixture');
    kit.queue.sent.length = 0;
    await requestRefresh(
      jobCtxOf(kit),
      testPass.id,
      { type: 'user', id: 'u1' },
      {
        orgId: testPass.orgId,
        mode: testPass.mode,
        version: testPass.version,
        linkGeneration: testPass.linkGeneration,
        status: testPass.status,
        identityId: testPass.identityId,
        credentialGeneration: testPass.credentialGeneration,
        templateId: testPass.templateId,
        templateVersion: testPass.templateVersion,
        releaseId: testPass.releaseId,
        lifecycleGeneration: testPass.lifecycleGeneration,
        connectionId: null,
        externalRef: null,
      },
    );
    expect(kit.queue.sent).toContainEqual(
      expect.objectContaining({
        kind: 'pass.refresh',
        passId: testPass.id,
        mode: 'test',
        connectionId: null,
        externalRef: null,
        generation: null,
        connectionMode: null,
        passVersion: testPass.version,
        identityId: testPass.identityId,
        credentialGeneration: testPass.credentialGeneration,
        templateId: testPass.templateId,
        templateVersion: testPass.templateVersion,
        releaseId: testPass.releaseId,
        lifecycleGeneration: testPass.lifecycleGeneration,
      }),
    );
    const { pass, context } = await linked('test');
    await expect(
      bindPassConnection(
        jobCtxOf(kit),
        { type: 'user', id: 'u1' },
        pass.id,
        { connectionId: null, externalRef: null },
        null,
      ),
    ).rejects.toMatchObject({ code: 'MODE_MISMATCH' });
    expect((await getPass(kit.env.DB, pass.id))?.connectionId).toBe(context.connectionId);
  });

  it('hides quarantined legacy Test passes from reads, lists, and publication', async () => {
    const pass = await kit.pass({ mode: 'test' });
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    expect(await getPass(kit.env.DB, pass.id)).toBeNull();
    expect(await getPassByDownloadToken(kit.env.DB, pass.downloadToken)).toBeNull();
    expect(await getPassBySerial(kit.env.DB, pass.identityId, pass.serial)).toBeNull();
    expect(
      (await listPasses(kit.env.DB, { orgId: pass.orgId, mode: 'test', limit: 100 })).items.map(
        (p) => p.id,
      ),
    ).not.toContain(pass.id);
    await expect(
      publishPass(jobCtxOf(kit), {
        passId: pass.id,
        cause: 'admin',
        actor: { type: 'user', id: 'u1' },
        force: true,
      }),
    ).rejects.toMatchObject({ code: 'PASS_NOT_FOUND' });
    expect((await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects).toHaveLength(1);
  });
});
