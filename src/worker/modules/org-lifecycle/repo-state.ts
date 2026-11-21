import { grant } from '../../platform/authority.ts';
import { exists } from '../../platform/authority-cond.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { OrgWriteAuthority } from '../orgs/repo-org-writes.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import type { LifecycleRow } from './repo.ts';

export const CLOSE_WINDOW_MS = 30 * 86_400_000;

/** A platform admin's live session, or the org's own admin, as the grant's principal. */
export type CloseBy =
  | { kind: 'platform'; userId: string; sessionId: string }
  | { kind: 'owner'; authority: OrgWriteAuthority };

/**
 * `platform.org.close` / `org.org.close`: the org moves from the status the caller read to closed, with its
 * window. The default identity is cleared (as a delete always did) and remembered for a reopen. The hold
 * trigger refuses the move under a legal hold. False when the org was no longer in `from`.
 */
export async function closeOrgRow(
  ctx: ServiceContext,
  before: LifecycleRow,
  by: CloseBy,
): Promise<boolean> {
  const now = ctx.clock.now();
  const g =
    by.kind === 'platform'
      ? grant(ctx, {
          purpose: 'platform.org.close',
          principal: { kind: 'platform', userId: by.userId, sessionIdHash: by.sessionId },
          target: before.id,
        })
      : grant(ctx, {
          purpose: 'org.org.close',
          principal: tenantPrincipal(by.authority),
          target: before.id,
          checks: capabilityChecks(by.authority),
        });
  g.update('orgs', {
    set: {
      status: 'deleted',
      default_identity_id: null,
      closed_identity_id: before.default_identity_id,
      closed_at: now,
      purge_after: now + CLOSE_WINDOW_MS,
      updated_at: maxNow(now),
    },
    where: by.kind === 'platform' ? { id: before.id, status: before.status } : { status: 'active' },
    returning: ['id'],
  });
  // A developer sandbox records the close too; the statement runs only when the org moved above.
  g.update('developer_sandboxes', {
    set: { closed_at: now, close_reason: by.kind === 'platform' ? 'admin' : 'user' },
    where: { org_id: before.id, closed_at: null },
    when: [exists('orgs', { id: before.id, status: 'deleted' })],
  });
  const [result] = await g.commit();
  return (result?.results.length ?? 0) > 0;
}

/**
 * `platform.org.reopen`: back to active inside the window, with the default identity it had. The identity is
 * restored only while it still belongs to the org (`identityBack`). False when the org is not closed, a purge
 * has started or the window is over.
 */
export async function reopenOrgRow(
  ctx: ServiceContext,
  before: LifecycleRow,
  by: { userId: string; sessionId: string },
  identityBack: string | null,
): Promise<boolean> {
  const now = ctx.clock.now();
  const g = grant(ctx, {
    purpose: 'platform.org.reopen',
    principal: { kind: 'platform', userId: by.userId, sessionIdHash: by.sessionId },
    target: before.id,
  });
  g.update('orgs', {
    set: {
      status: 'active',
      default_identity_id: identityBack,
      closed_identity_id: null,
      closed_at: null,
      purge_after: null,
      updated_at: maxNow(now),
    },
    where: { id: before.id, status: 'deleted', purge_started_at: null },
    returning: ['id'],
  });
  g.update('developer_sandboxes', {
    set: { closed_at: null, close_reason: null },
    where: { org_id: before.id },
    when: [exists('orgs', { id: before.id, status: 'active' })],
  });
  const [result] = await g.commit();
  return (result?.results.length ?? 0) > 0;
}
