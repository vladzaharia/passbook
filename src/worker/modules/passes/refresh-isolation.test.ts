import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { overrideDeps } from './deps.ts';
import { bindPassConnection } from './connection-bind.ts';
import { applyConnectionRecord, markPassMissing } from './connection-passes.ts';
import { getPass, getPassByDownloadToken, getPassBySerial, listPasses, setBinding } from './repo.ts';
import { publishPass } from './publish.ts';
import { requestRefresh, updatePass } from './service.ts';
import { type Kit, setupKit } from './test-kit.ts';

let kit: Kit;
beforeAll(async () => { kit = await setupKit(); });

async function linked() {
  const pass = await kit.pass();
  const connectionId = kit.fx.ids.id();
  await run(kit.env.DB,
    `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
     VALUES (?, ?, 'demo', 'race', 1, 1, 1)`, [connectionId, pass.orgId]);
  await run(kit.env.DB,
    "UPDATE passes SET connection_id = ?, external_ref = 'ref', field_sources = '{}' WHERE id = ?",
    [connectionId, pass.id]);
  const current = await getPass(kit.env.DB, pass.id);
  if (!current) throw new Error('Missing fixture pass');
  return {
    pass: current,
    context: {
      passId: current.id, orgId: current.orgId, mode: 'live' as const,
      status: 'active' as const, expectedVersion: current.version,
      ownerUserId: current.ownerUserId, linkGeneration: current.linkGeneration,
      connectionId, externalRef: 'ref', generation: 1,
    },
  };
}

const persisted = (id: string) => first(kit.env.DB,
  `SELECT org_id, mode, status, version, connection_id, external_ref, deleted_at, removed_at,
    test_data_quarantined, owner_user_id, holder_email, link_generation, download_token,
    personalization, field_sources, object_key, sync_error_code FROM passes WHERE id = ?`, [id]);

describe('connector snapshot fencing', () => {
  it.each([
    'version', 'mode', 'organization', 'status', 'removed', 'deleted', 'quarantine',
    'reference', 'unbound', 'generation', 'disabled', 'connection-org', 'org-status', 'holder',
  ] as const)('loses the final publish CAS after a %s change without keeping the new object', async (change) => {
    const { pass, context } = await linked();
    const otherOrg = await makeOrg(kit.fx, { name: `Other ${kit.fx.ids.token(4)}` });
    const user = await makeUser(kit.fx);
    let raced: unknown;
    const put = kit.env.BUCKET.put.bind(kit.env.BUCKET);
    const spy = vi.spyOn(kit.env.BUCKET, 'put').mockImplementation(async (key, value, options) => {
      const object = await put(key, value, options);
      if (key.startsWith(`passes/${pass.id}/`)) {
        switch (change) {
          case 'version': await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]); break;
          case 'mode': await run(kit.env.DB, "UPDATE passes SET mode = 'test' WHERE id = ?", [pass.id]); break;
          case 'organization': await run(kit.env.DB, 'UPDATE passes SET org_id = ? WHERE id = ?', [otherOrg.id, pass.id]); break;
          case 'status': await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]); break;
          case 'removed': await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [pass.id]); break;
          case 'deleted': await run(kit.env.DB, 'UPDATE passes SET deleted_at = 1 WHERE id = ?', [pass.id]); break;
          case 'quarantine': await run(kit.env.DB, "UPDATE passes SET mode = 'test', test_data_quarantined = 1 WHERE id = ?", [pass.id]); break;
          case 'reference': await run(kit.env.DB, "UPDATE passes SET external_ref = 'other' WHERE id = ?", [pass.id]); break;
          case 'unbound': await run(kit.env.DB, 'UPDATE passes SET connection_id = NULL, external_ref = NULL WHERE id = ?', [pass.id]); break;
          case 'generation': await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [context.connectionId]); break;
          case 'disabled': await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [context.connectionId]); break;
          case 'connection-org': await run(kit.env.DB, 'UPDATE connections SET org_id = ? WHERE id = ?', [otherOrg.id, context.connectionId]); break;
          case 'org-status': await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [pass.orgId]); break;
          case 'holder': await run(kit.env.DB, 'UPDATE passes SET owner_user_id = ?, link_generation = link_generation + 1 WHERE id = ?', [user.id, pass.id]); break;
        }
        raced = await persisted(pass.id);
      }
      return object;
    });
    try {
      await expect(applyConnectionRecord(kit.ctx, {
        ...context, fields: { memberName: 'Stale' }, holderEmail: 'stale@example.test', cause: 'connection',
      })).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      expect(await persisted(pass.id)).toEqual(raced);
      expect((await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects).toHaveLength(1);
    } finally {
      spy.mockRestore();
      if (change === 'org-status') await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [pass.orgId]);
    }
  });

  it('atomically changes a holder and revokes old bundle links even when the artifact is unchanged', async () => {
    const { pass, context } = await linked();
    const bundleId = kit.fx.ids.id();
    await run(kit.env.DB, "INSERT INTO bundles (id, org_id, name, token, created_at) VALUES (?, ?, 'B', ?, 1)",
      [bundleId, pass.orgId, kit.fx.ids.token()]);
    await run(kit.env.DB, 'INSERT INTO bundle_passes (bundle_id, pass_id, position) VALUES (?, ?, 0)', [bundleId, pass.id]);
    const result = await applyConnectionRecord(kit.ctx, {
      ...context, fields: {}, holderEmail: 'new@example.test', cause: 'connection',
    });
    const updated = await getPass(kit.env.DB, pass.id);
    expect(result).toMatchObject({ changed: false, version: pass.version + 1, linkGeneration: pass.linkGeneration + 1 });
    expect(updated?.holderEmail).toBe('new@example.test');
    expect(updated?.downloadToken).not.toBe(pass.downloadToken);
    expect(await first(kit.env.DB, 'SELECT 1 FROM bundle_passes WHERE bundle_id = ? AND pass_id = ?', [bundleId, pass.id])).toBeNull();
  });

  it('does not change holder, sync error, or bundle membership when metadata CAS is stale', async () => {
    const { pass, context } = await linked();
    const bundleId = kit.fx.ids.id();
    await run(kit.env.DB, "INSERT INTO bundles (id, org_id, name, token, created_at) VALUES (?, ?, 'B', ?, 1)",
      [bundleId, pass.orgId, kit.fx.ids.token()]);
    await run(kit.env.DB, 'INSERT INTO bundle_passes (bundle_id, pass_id, position) VALUES (?, ?, 0)', [bundleId, pass.id]);
    overrideDeps(kit.env, { registry: {
      list: (q) => kit.registry.list(q), openAsset: (t, n) => kit.registry.openAsset(t, n),
      async resolve(id, version) {
        await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [context.connectionId]);
        return kit.registry.resolve(id, version);
      },
    } });
    try {
      await expect(applyConnectionRecord(kit.ctx, {
        ...context, fields: {}, holderEmail: 'stale@example.test', cause: 'connection',
      })).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
        version: pass.version, holderEmail: pass.holderEmail, downloadToken: pass.downloadToken,
        linkGeneration: pass.linkGeneration, syncErrorCode: null,
      });
      expect(await first(kit.env.DB, 'SELECT 1 AS ok FROM bundle_passes WHERE bundle_id = ? AND pass_id = ?', [bundleId, pass.id])).toEqual({ ok: 1 });
    } finally {
      overrideDeps(kit.env, { registry: kit.registry });
    }
  });

  it('revalidates connection generation before writing a built artifact to R2', async () => {
    const { pass, context } = await linked();
    const put = vi.spyOn(kit.env.BUCKET, 'put');
    overrideDeps(kit.env, { registry: {
      list: (q) => kit.registry.list(q), openAsset: (t, n) => kit.registry.openAsset(t, n),
      async resolve(id, version) {
        await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [context.connectionId]);
        return kit.registry.resolve(id, version);
      },
    } });
    try {
      await expect(applyConnectionRecord(kit.ctx, {
        ...context, fields: { memberName: 'Stale' }, cause: 'connection',
      })).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
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
    await expect(markPassMissing(kit.ctx, context, 'flag')).rejects.toMatchObject({ code: 'PASS_CONNECTION_MISMATCH' });
    expect((await getPass(kit.env.DB, pass.id))?.syncErrorCode).toBeNull();
  });

  it('does not bind over a version changed after selection', async () => {
    const { pass, context } = await linked();
    await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]);
    expect(await setBinding(kit.env.DB, pass, {
      connectionId: context.connectionId, externalRef: 'new-ref', fieldSources: {}, generation: 1,
    })).toBe(false);
    expect((await getPass(kit.env.DB, pass.id))?.externalRef).toBe('ref');
  });

  it.each(['generation', 'disabled', 'organization'] as const)(
    'does not bind after the target connection changes %s',
    async (change) => {
      const { pass, context } = await linked();
      const before = await persisted(pass.id);
      if (change === 'generation')
        await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [context.connectionId]);
      else if (change === 'disabled')
        await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [context.connectionId]);
      else {
        const org = await makeOrg(kit.fx, { name: `Other ${kit.fx.ids.token(4)}` });
        await run(kit.env.DB, 'UPDATE connections SET org_id = ? WHERE id = ?', [org.id, context.connectionId]);
      }
      expect(await setBinding(kit.env.DB, pass, {
        connectionId: context.connectionId, externalRef: 'new-ref', fieldSources: {}, generation: 1,
      })).toBe(false);
      expect(await persisted(pass.id)).toEqual(before);
    },
  );

  it.each(['version', 'status', 'removed', 'deleted', 'quarantine', 'reference'] as const)(
    'does not unbind after the selected pass changes %s',
    async (change) => {
      const { pass } = await linked();
      if (change === 'version') await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]);
      else if (change === 'status') await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
      else if (change === 'removed') await run(kit.env.DB, 'UPDATE passes SET removed_at = 1 WHERE id = ?', [pass.id]);
      else if (change === 'deleted') await run(kit.env.DB, 'UPDATE passes SET deleted_at = 1 WHERE id = ?', [pass.id]);
      else if (change === 'quarantine') await run(kit.env.DB, "UPDATE passes SET mode = 'test', test_data_quarantined = 1 WHERE id = ?", [pass.id]);
      else await run(kit.env.DB, "UPDATE passes SET external_ref = 'other' WHERE id = ?", [pass.id]);
      const afterRace = await persisted(pass.id);
      expect(await setBinding(kit.env.DB, pass, {
        connectionId: null, externalRef: null, fieldSources: pass.fieldSources, generation: null,
      })).toBe(false);
      expect(await persisted(pass.id)).toEqual(afterRace);
    },
  );

  it.each(['test', 'disabled'] as const)(
    'does not apply a reset-to-connection patch with a %s binding',
    async (change) => {
      const { pass, context } = await linked();
      if (change === 'test')
        await run(kit.env.DB, "UPDATE passes SET mode = 'test' WHERE id = ?", [pass.id]);
      else
        await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [context.connectionId]);
      const before = await persisted(pass.id);
      await expect(updatePass(
        kit.ctx, { type: 'user', id: 'u1' }, pass.id,
        { input: { memberName: 'Must not be saved' }, resetToConnection: ['memberName'] },
        { scope: null },
      )).rejects.toMatchObject({ code: change === 'test' ? 'MODE_MISMATCH' : 'PASS_CONFLICT' });
      expect(await persisted(pass.id)).toEqual(before);
      expect((await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects).toHaveLength(1);
    },
  );

  it('keeps unbound Test refreshes and fences unsafe legacy Test unbinding', async () => {
    const unbound = await kit.pass();
    await run(kit.env.DB, "UPDATE passes SET mode = 'test' WHERE id = ?", [unbound.id]);
    const testPass = await getPass(kit.env.DB, unbound.id);
    if (!testPass) throw new Error('Missing Test fixture');
    kit.queue.sent.length = 0;
    await requestRefresh(kit.ctx, testPass.id, { type: 'user', id: 'u1' }, {
      orgId: testPass.orgId, mode: testPass.mode, version: testPass.version,
      linkGeneration: testPass.linkGeneration, status: testPass.status,
      connectionId: null, externalRef: null,
    });
    expect(kit.queue.sent).toContainEqual(expect.objectContaining({
      kind: 'pass.refresh', passId: testPass.id, mode: 'test', connectionId: null,
      externalRef: null, generation: null, passVersion: testPass.version,
    }));
    const { pass, context } = await linked();
    await run(kit.env.DB, "UPDATE passes SET mode = 'test' WHERE id = ?", [pass.id]);
    await expect(bindPassConnection(
      kit.ctx, { type: 'user', id: 'u1' }, pass.id, { connectionId: null, externalRef: null }, null,
    )).rejects.toMatchObject({ code: 'MODE_MISMATCH' });
    expect((await getPass(kit.env.DB, pass.id))?.connectionId).toBe(context.connectionId);
  });

  it('hides quarantined legacy Test passes from reads, lists, and publication', async () => {
    const pass = await kit.pass();
    await run(kit.env.DB, "UPDATE passes SET mode = 'test', test_data_quarantined = 1 WHERE id = ?", [pass.id]);
    expect(await getPass(kit.env.DB, pass.id)).toBeNull();
    expect(await getPassByDownloadToken(kit.env.DB, pass.downloadToken)).toBeNull();
    expect(await getPassBySerial(kit.env.DB, pass.identityId, pass.serial)).toBeNull();
    expect((await listPasses(kit.env.DB, { orgId: pass.orgId, mode: 'test', limit: 100 })).items.map((p) => p.id))
      .not.toContain(pass.id);
    await expect(publishPass(kit.ctx, {
      passId: pass.id, cause: 'admin', actor: { type: 'user', id: 'u1' }, force: true,
    })).rejects.toMatchObject({ code: 'PASS_NOT_FOUND' });
    expect((await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects).toHaveLength(1);
  });
});
