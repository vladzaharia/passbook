import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { createPassFromConnection } from './connection-passes-create.ts';
import { ensureCredentialRefKeyset } from './credential-keyset.ts';
import { startCredentialTransfer } from './credential-transfer.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';
import { deletePass } from './service.ts';

interface LinkRow {
  id: string;
  connection_id: string;
  object_type: string;
  external_id: string;
  local_id: string;
  role: string;
  state: string;
}

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

async function connection() {
  const id = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
     VALUES (?, ?, 'demo', 'c', 1, 1, 1)`,
    [id, kit.org.id],
  );
  return id;
}

const linksOf = (passId: string) =>
  all<LinkRow>(
    kit.env.DB,
    `SELECT id, connection_id, object_type, external_id, local_id, role, state
     FROM connection_links WHERE local_id = ?`,
    [passId],
  );

const primary = (connectionId: string, externalRef: string, passId: string) => ({
  id: `primary:${passId}`,
  connection_id: connectionId,
  object_type: 'record',
  external_id: externalRef,
  local_id: passId,
  role: 'primary',
  state: 'active',
});

async function bound(ref: string) {
  const connectionId = await connection();
  const pass = await kit.pass();
  await run(kit.env.DB, 'UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
    connectionId,
    ref,
    pass.id,
  ]);
  return { connectionId, pass };
}

describe('primary link mirror on bind paths', () => {
  it('is written when a connection sync creates a pass', async () => {
    const connectionId = await connection();
    const release = await requireApprovedRelease(
      kit.ctx,
      kit.template.id,
      kit.org.id,
      'live',
      'apple',
    );
    const { passId } = await createPassFromConnection(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: kit.template.id,
      expectedRelease: { id: release.id, generation: release.generation, version: release.version },
      mode: 'live',
      generation: 1,
      expectedConnectionMode: 'poll',
      credentialKeysetCommitment: await ensureCredentialRefKeyset(kit.env.DB, kit.env),
      connectionId,
      externalRef: 'sync-ref-1',
      fields: { memberName: 'Synced' },
      holderEmail: null,
      sendEmail: false,
    });
    const pass = await getPass(kit.env.DB, passId);
    expect(pass).toMatchObject({ connectionId, externalRef: 'sync-ref-1' });
    expect(await linksOf(passId)).toEqual([primary(connectionId, 'sync-ref-1', passId)]);
  });

  it('survives a holder transfer of a bound pass', async () => {
    const { connectionId, pass } = await bound('xfer-ref');
    const expected = await getHolderPass(kit.env.DB, pass.id, null);
    if (!expected) throw new Error('Missing holder source');
    const started = await startCredentialTransfer(
      jobCtxOf(kit),
      { type: 'system', id: null },
      pass.id,
      { holderEmail: 'next@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected },
    );
    expect(started.state).toBe('completed');
    expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
      holderEmail: 'next@example.test',
      connectionId,
      externalRef: 'xfer-ref',
    });
    expect(await linksOf(pass.id)).toEqual([primary(connectionId, 'xfer-ref', pass.id)]);
  });

  it('is removed when the pass is deleted and its binding cleared', async () => {
    const { pass } = await bound('del-ref');
    expect(await linksOf(pass.id)).toHaveLength(1);
    await deletePass(jobCtxOf(kit), { type: 'system', id: null }, pass.id, null);
    expect(
      await first(
        kit.env.DB,
        'SELECT connection_id, external_ref, deleted_at IS NOT NULL AS gone FROM passes WHERE id = ?',
        [pass.id],
      ),
    ).toEqual({ connection_id: null, external_ref: null, gone: 1 });
    expect(await linksOf(pass.id)).toEqual([]);
  });
});
