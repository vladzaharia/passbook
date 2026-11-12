import { describe, expect, it, vi } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { requireCredentialRefKeyset } from './credential-keyset.ts';
import { finishCredentialTransfer, startCredentialTransfer } from './credential-transfer.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';

const target = { holderEmail: 'next@example.test', ownerUserId: null } as const;

/** Holds the finish at its artifact upload, so the test can change state while the transfer is pending. */
function uploadGate(kit: Kit, passId: string) {
  const arrived = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const original = kit.env.BUCKET.put.bind(kit.env.BUCKET);
  const spy = vi.spyOn(kit.env.BUCKET, 'put').mockImplementation(async (key, bytes, options) => {
    if (key.startsWith(`passes/${passId}/`)) {
      arrived.resolve();
      await gate.promise;
    }
    return original(key, bytes, options);
  });
  return { arrived: arrived.promise, release: gate.resolve, spy };
}

async function connectedPass(kit: Kit) {
  const original = await kit.pass({ memberName: 'Old member' });
  const connectionId = kit.ctx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO connections (id,org_id,connector_type,name,generation,created_at,updated_at)
     VALUES (?,?,'demo','source',1,?,?)`,
    [connectionId, original.orgId, kit.clock.now(), kit.clock.now()],
  );
  await run(kit.env.DB, "UPDATE passes SET connection_id = ?, external_ref = 'ref' WHERE id = ?", [
    connectionId,
    original.id,
  ]);
  const pass = await getPass(kit.env.DB, original.id);
  if (!pass) throw new Error('Missing connected pass');
  return { pass, connectionId };
}

describe('credential transfer liveness (authority-epochs.md F11, F15)', () => {
  it('completes a connector transfer after a release is approved and the connection is edited while it is pending', async () => {
    const kit = await setupKit();
    const { pass, connectionId } = await connectedPass(kit);
    const expected = await getHolderPass(kit.env.DB, pass.id, null);
    if (!expected) throw new Error('Missing holder source');
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
            personalization: { memberName: 'New member' },
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

      const release = await approveAppleRelease(kit);
      await run(kit.env.DB, 'UPDATE connections SET config = \'{"edited":true}\' WHERE id = ?', [
        connectionId,
      ]);
      const edited = await first<{ generation: number }>(
        kit.env.DB,
        'SELECT generation FROM connections WHERE id = ?',
        [connectionId],
      );
      expect(edited?.generation).toBeGreaterThan(1);
      gate.release();

      // The finish that was in flight built against the old head: it loses its fence and stays pending.
      const first_ = await work;
      expect(first_.transferId).toBe(pending.id);
      expect(['pending', 'completed']).toContain(first_.state);
      // The next finish rebuilds against the current head and the edited connection, and completes.
      await expect(finishCredentialTransfer(jobCtxOf(kit), pending.id)).resolves.toEqual({
        transferId: pending.id,
        state: 'completed',
      });
      expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
        releaseId: release.id,
        holderEmail: target.holderEmail,
        personalization: { memberName: 'New member' },
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

  it('completes a connector transfer when the connection is disabled while it is pending', async () => {
    const kit = await setupKit();
    const { pass, connectionId } = await connectedPass(kit);
    const expected = await getHolderPass(kit.env.DB, pass.id, null);
    if (!expected) throw new Error('Missing holder source');
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
          content: { personalization: { memberName: 'Later' }, fieldSources: {} },
        },
      );
      await gate.arrived;
      await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [connectionId]);
      gate.release();
      expect((await work).state).toBe('completed');
    } finally {
      gate.release();
      gate.spy.mockRestore();
    }
  }, 120_000);
});
