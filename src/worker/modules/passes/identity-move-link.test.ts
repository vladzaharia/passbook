import { beforeAll, describe, expect, it, vi } from 'vitest';
import { all, run } from '../../platform/db.ts';
import type { BroadcastKit } from '../broadcasts/test-kit.ts';
import { SECOND_ID } from './identity-move-resolver-test-fixtures.ts';
import {
  moveKit,
  moveOf,
  orgWithPasses,
  passOf,
  replacement,
  startAndRun,
} from './identity-move-test-fixtures.ts';

vi.mock('../identities/resolver.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../identities/resolver.ts')>();
  const { wrapResolver } = await import('./identity-move-resolver-test-fixtures.ts');
  return {
    ...original,
    createIdentityResolver: (...a: Parameters<typeof original.createIdentityResolver>) =>
      wrapResolver(original.createIdentityResolver(...a)),
  };
});

let kit: BroadcastKit;
beforeAll(async () => {
  kit = await moveKit();
});

const linksOf = (orgId: string) =>
  all<{ id: string; local_id: string; external_id: string; role: string }>(
    kit.env.DB,
    'SELECT id, local_id, external_id, role FROM connection_links WHERE org_id = ? ORDER BY local_id',
    [orgId],
  );

describe('identity move and the primary link mirror', () => {
  it('leaves a connection-bound pass and its link on the old identity', async () => {
    const { org, passes } = await orgWithPasses(kit, 2);
    const [boundPass, free] = passes;
    if (!boundPass || !free) throw new Error('Missing seeded passes');
    await run(
      kit.env.DB,
      "INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES ('c-link', ?, 'x', 'c', 1, 1)",
      [org.id],
    );
    await run(
      kit.env.DB,
      "UPDATE passes SET connection_id = 'c-link', external_ref = 'r-1' WHERE id = ?",
      [boundPass.id],
    );
    await startAndRun(kit, org.id);
    expect((await passOf(kit, boundPass.id)).identityId).toBe('platform');
    expect(await linksOf(org.id)).toEqual([
      {
        id: `primary:${boundPass.id}`,
        local_id: boundPass.id,
        external_id: 'r-1',
        role: 'primary',
      },
    ]);
    expect((await moveOf(kit, free.id)).to_identity_id).toBe(SECOND_ID);
  });

  it('gives the replacement of an unbound pass no link', async () => {
    const { org, passes } = await orgWithPasses(kit, 1);
    const [old] = passes;
    if (!old) throw new Error('Missing seeded pass');
    await startAndRun(kit, org.id);
    const made = await replacement(kit, old);
    expect(made.id).not.toBe(old.id);
    expect(made.connectionId).toBeNull();
    expect(await linksOf(org.id)).toEqual([]);
  });
});
