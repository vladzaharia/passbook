import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { bindPassConnection } from './connection-bind.ts';
import { applyConnectionRecord } from './connection-passes.ts';
import { requireCredentialRefKeyset } from './credential-keyset.ts';
import { forwardedId, replacementOf } from './pass-replaced.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import type { Pass } from './repo.ts';
import { getPass } from './repo-read-pass.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
});

/** `old` was replaced by `next`: the row a finished move leaves. */
async function replaced(old: Pass, next: Pass) {
  await run(
    kit.env.DB,
    `INSERT INTO pass_moves (id, op_id, org_id, mode, from_identity_id, to_identity_id, old_pass_id, new_pass_id,
       state, replaced_by, replaced_at, voided_at, created_at, updated_at)
     VALUES (?, 'op', ?, 'live', 'platform', 'other', ?, ?, 'voided', ?, 1, 1, 1, 1)`,
    [kit.fx.ids.id(), old.orgId, old.id, next.id, next.id],
  );
}
const pair = async () => {
  const old = await kit.pass({ memberName: 'Old Side' });
  const next = await kit.pass({ memberName: 'New Side' });
  await replaced(old, next);
  return { old, next };
};

describe('replacementOf', () => {
  it('names the replacement, follows a chain of moves and is null for a pass nobody replaced', async () => {
    const a = await kit.pass({ memberName: 'A' });
    const b = await kit.pass({ memberName: 'B' });
    const c = await kit.pass({ memberName: 'C' });
    await replaced(a, b);
    await replaced(b, c);
    expect(await replacementOf(kit.env.DB, a.id)).toBe(c.id);
    expect(await replacementOf(kit.env.DB, b.id)).toBe(c.id);
    expect(await replacementOf(kit.env.DB, c.id)).toBeNull();
    expect(await forwardedId(kit.env.DB, c.id)).toBe(c.id);
  });

  it('takes a first hop the caller already read, then follows the rest', async () => {
    const a = await kit.pass({ memberName: 'A1' });
    const b = await kit.pass({ memberName: 'B1' });
    const c = await kit.pass({ memberName: 'C1' });
    await replaced(a, b);
    await replaced(b, c);
    expect(await replacementOf(kit.env.DB, a.id, b.id)).toBe(c.id);
    expect(await replacementOf(kit.env.DB, c.id, null)).toBeNull();
  });

  it('ignores a move that has not replaced the old pass yet', async () => {
    const old = await kit.pass({ memberName: 'Waiting' });
    const next = await kit.pass({ memberName: 'Next' });
    await replaced(old, next);
    await run(kit.env.DB, 'UPDATE pass_moves SET replaced_by = NULL WHERE old_pass_id = ?', [
      old.id,
    ]);
    expect(await replacementOf(kit.env.DB, old.id)).toBeNull();
  });
});

describe('API writes by the old pass id', () => {
  it('are forwarded to the replacement, and the old pass is left as it was', async () => {
    const { old, next } = await pair();
    const res = await app.request(
      `https://wallet.test/api/v1/passes/${old.id}`,
      {
        method: 'PATCH',
        headers: { ...auth.admin(), 'content-type': 'application/json' },
        body: JSON.stringify({ input: { memberName: 'Forwarded' } }),
      },
      kit.env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-forwarded-from')).toBe(old.id);
    expect(((await res.json()) as { id: string }).id).toBe(next.id);
    expect((await getPass(kit.env.DB, next.id))?.personalization.memberName).toBe('Forwarded');
    expect((await getPass(kit.env.DB, old.id))?.personalization.memberName).toBe('Old Side');
  });
});

describe('connector writes to a replaced pass', () => {
  it('refuses a bind with PASS_REPLACED, naming the replacement', async () => {
    const { old, next } = await pair();
    await run(
      kit.env.DB,
      "INSERT OR IGNORE INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES ('c-rep', ?, 'demo', 'c', 1, 1)",
      [kit.org.id],
    );
    const error = await bindPassConnection(
      jobCtxOf(kit),
      { type: 'user', id: 'admin-1' },
      old.id,
      { connectionId: 'c-rep', externalRef: 'r-1' },
      null,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'PASS_REPLACED', status: 409 });
    expect((error as Error).message).toContain(next.id);
  });

  it('refuses a sync of the old pass with PASS_REPLACED rather than writing it', async () => {
    const { old, next } = await pair();
    await run(
      kit.env.DB,
      "INSERT OR IGNORE INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES ('c-sync', ?, 'demo', 'c', 1, 1)",
      [kit.org.id],
    );
    await run(
      kit.env.DB,
      "UPDATE passes SET connection_id = 'c-sync', external_ref = 'r-2' WHERE id = ?",
      [old.id],
    );
    const fresh = (await getPass(kit.env.DB, old.id)) as Pass;
    const error = await applyConnectionRecord(jobCtxOf(kit), {
      passId: old.id,
      orgId: kit.org.id,
      mode: 'live',
      status: 'active',
      expectedVersion: fresh.version,
      ownerUserId: fresh.ownerUserId,
      linkGeneration: fresh.linkGeneration,
      identityId: fresh.identityId,
      credentialGeneration: fresh.credentialGeneration,
      lifecycleGeneration: fresh.lifecycleGeneration,
      credentialKeysetCommitment: await requireCredentialRefKeyset(kit.env.DB, kit.env),
      transferPending: false,
      connectionId: 'c-sync',
      externalRef: 'r-2',
      generation: 1,
      expectedConnectionMode: 'poll',
      fields: { memberName: 'Upstream' },
      cause: 'connection',
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'PASS_REPLACED', status: 409 });
    expect((error as Error).message).toContain(next.id);
    expect(await first(kit.env.DB, 'SELECT version FROM passes WHERE id = ?', [old.id])).toEqual({
      version: fresh.version,
    });
  });
});
