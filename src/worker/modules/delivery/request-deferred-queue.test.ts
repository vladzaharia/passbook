import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { loadUserAccessRevision } from '../passes/repo-access-revision.ts';
import { inboxAuthority, inboxMember } from '../sandbox/test-tenant-fixtures.ts';
import { enqueuePassEmail } from './issuance-intent.ts';
import { deferredActors } from './repo-email-queue.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

/**
 * The issuance resume runs on the creating request's context with the authority captured in the
 * durable intent, so the queueing grant is a deferred principal on a request context.
 */
async function resume(mutate?: (m: { userId: string; membershipId: string }) => Promise<void>) {
  const user = await makeUser(kit.fx);
  const member = await inboxMember(kit, user.id, kit.org.id, 'org_admin');
  const authority = await inboxAuthority(kit, member.session);
  const userRevision = await loadUserAccessRevision(kit.env.DB, user.id);
  const to = `${kit.ctx.ids.token(8).toLowerCase()}@example.com`;
  const pass = await kit.pass({ mode: 'test', memberName: 'Resume', holderEmail: to });
  await mutate?.({ userId: user.id, membershipId: member.membershipId });
  return enqueuePassEmail(kit.ctx, {
    passId: pass.id,
    to,
    attach: false,
    expected: pass,
    queuedFor: deferredActors([authority], [userRevision ?? undefined]),
  });
}

describe('queueing under a request-context deferred principal', () => {
  it('queues for a live member whose session is gone (positive control)', async () => {
    const queued = await resume(async ({ userId }) => {
      await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ?', [
        kit.clock.now(),
        userId,
      ]);
    });
    expect(
      await first(kit.env.DB, 'SELECT id FROM outbox WHERE id = ?', [queued.outboxId]),
    ).not.toBeNull();
  });

  it('refuses a revoked membership with 403', async () => {
    await expect(
      resume(async ({ membershipId }) => {
        await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
          kit.clock.now(),
          membershipId,
        ]);
      }),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('refuses a moved org access revision with 403 ORG_ACCESS_CHANGED', async () => {
    await expect(
      resume(async () => {
        await run(
          kit.env.DB,
          'UPDATE orgs SET access_revision = access_revision + 1 WHERE id = ?',
          [kit.org.id],
        );
      }),
    ).rejects.toMatchObject({ status: 403, code: 'ORG_ACCESS_CHANGED' });
  });

  it('refuses a moved user access revision with 403', async () => {
    await expect(
      resume(async ({ userId }) => {
        await run(
          kit.env.DB,
          'UPDATE users SET access_revision = access_revision + 1 WHERE id = ?',
          [userId],
        );
      }),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
});
