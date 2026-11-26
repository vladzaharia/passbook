import { developerSandboxGrant } from '../../jobs/developer-sandbox.ts';
import { rawCheck } from '../../platform/authority-checks.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import { addOrgEntitlements } from '../../platform/entitlements.ts';
import { STRONG_AMR_SQL } from '../../platform/repo-session-strength-sql.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';

/** A closed sandbox's window to export, like any closed org (`CLOSE_WINDOW_MS`). */
const CLOSE_WINDOW_MS = 30 * 86_400_000;

export interface NewSandbox {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  userId: string;
  email: string;
  sessionIdHash: string;
  membershipId: string;
  invitationId: string;
  invitationHash: string;
  now: number;
}

/**
 * `platform.job.developer_sandbox.create`: the org (kind `developer`, preset `developer`), the person as its
 * admin and the sandbox record, in one batch. It commits only while the person's session is live and they
 * have no sandbox: a refusal leaves nothing behind.
 */
export async function insertSandbox(ctx: ServiceContext, s: NewSandbox): Promise<void> {
  const live = rawCheck(
    'actor',
    `EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.user_id = ? AND u.status = 'active' AND s.revoked_at IS NULL
        AND s.expires_at > ? AND s.idle_expires_at > ? AND s.amr IN ${STRONG_AMR_SQL})`,
    [s.sessionIdHash, s.userId, s.now, s.now],
  );
  const none = rawCheck(
    'config',
    'NOT EXISTS (SELECT 1 FROM developer_sandboxes d WHERE d.user_id = ?)',
    [s.userId],
  );
  const g = developerSandboxGrant(ctx, 'platform.job.developer_sandbox.create', [live, none]);
  g.insertSelect(
    'orgs',
    ['id', 'slug', 'name', 'status', 'kind', 'branding', 'created_at', 'updated_at'],
    [s.orgId, s.slug, s.name, 'active', 'developer', '{}', s.now, s.now],
  );
  addOrgEntitlements(g, s.orgId, 'developer', s.now);
  g.insertSelect(
    'org_invitations',
    ['id', 'org_id', 'email', 'roles', 'token_hash', 'created_at', 'expires_at', 'accepted_at'],
    [
      s.invitationId,
      s.orgId,
      s.email,
      '["org_admin"]',
      s.invitationHash,
      s.now,
      s.now + 1000,
      s.now,
    ],
  );
  g.insertSelect(
    'org_memberships',
    ['id', 'org_id', 'user_id', 'invitation_id', 'roles', 'created_at'],
    [s.membershipId, s.orgId, s.userId, s.invitationId, '["org_admin"]', s.now],
  );
  g.insertSelect(
    'developer_sandboxes',
    ['id', 'org_id', 'user_id', 'created_at'],
    [s.id, s.orgId, s.userId, s.now],
  );
  grantedAudit(g, ctx, {
    orgId: s.orgId,
    actorType: 'user',
    actorId: s.userId,
    action: 'developer_sandbox.create',
    targetType: 'org',
    targetId: s.orgId,
  });
  await g.commit();
}

/**
 * `platform.job.developer_sandbox.close`: closes an active sandbox org and records why. The idle sweep passes no
 * `by`; the owner's own close passes their live session, which the grant checks, and also revokes the sandbox's
 * keys. False when the org was no longer active.
 */
export async function closeSandbox(
  ctx: ServiceContext,
  orgId: string,
  by?: { userId: string; sessionIdHash: string },
  /** Why a close with no session closed: idle (the default) or by the platform (`admin`). */
  reason: 'idle' | 'admin' = 'idle',
): Promise<boolean> {
  const now = ctx.clock.now();
  const checks = by
    ? [
        rawCheck(
          'actor',
          `EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.id_hash = ? AND s.user_id = ? AND u.status = 'active' AND s.revoked_at IS NULL
              AND s.expires_at > ? AND s.idle_expires_at > ? AND s.amr IN ${STRONG_AMR_SQL})`,
          [by.sessionIdHash, by.userId, now, now],
        ),
        rawCheck('config', 'EXISTS (SELECT 1 FROM developer_sandboxes d WHERE d.user_id = ?)', [
          by.userId,
        ]),
      ]
    : [];
  const g = developerSandboxGrant(ctx, 'platform.job.developer_sandbox.close', checks, orgId);
  g.update('orgs', {
    set: {
      status: 'deleted',
      default_identity_id: null,
      closed_at: now,
      purge_after: now + CLOSE_WINDOW_MS,
      updated_at: maxNow(now),
    },
    where: { id: orgId, status: 'active', kind: 'developer' },
    returning: ['id'],
  });
  // The idle sweep revokes too: a reopen must not bring back a key nobody has watched for a month.
  g.update('api_keys', { set: { revoked_at: now }, where: { org_id: orgId, revoked_at: null } });
  g.update('developer_sandboxes', {
    set: { closed_at: now, close_reason: by ? 'user' : reason },
    where: by
      ? { org_id: orgId, user_id: by.userId, closed_at: null }
      : { org_id: orgId, closed_at: null },
  });
  grantedAudit(g, ctx, {
    orgId,
    actorType: by ? 'user' : 'system',
    ...(by ? { actorId: by.userId } : {}),
    action: 'developer_sandbox.close',
    targetType: 'org',
    targetId: orgId,
    detail: { reason: by ? 'user' : reason },
  });
  const [closed] = await g.commit();
  return (closed?.results.length ?? 0) > 0;
}

/**
 * `platform.job.developer_sandbox.try_revoke`: raises the open sandbox's try generation, so every try token made
 * before stops at once. Only the sandbox's person, from a live session. False when there is no open sandbox.
 */
export async function bumpTryGeneration(
  ctx: ServiceContext,
  orgId: string,
  by: { userId: string; sessionIdHash: string },
): Promise<boolean> {
  const now = ctx.clock.now();
  const live = rawCheck(
    'actor',
    `EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.user_id = ? AND u.status = 'active' AND s.revoked_at IS NULL
        AND s.expires_at > ? AND s.idle_expires_at > ? AND s.amr IN ${STRONG_AMR_SQL})`,
    [by.sessionIdHash, by.userId, now, now],
  );
  const g = developerSandboxGrant(ctx, 'platform.job.developer_sandbox.try_revoke', [live], orgId);
  g.update('developer_sandboxes', {
    set: { try_generation: maxNow(now) },
    where: { org_id: orgId, user_id: by.userId, closed_at: null },
    returning: ['id'],
  });
  grantedAudit(g, ctx, {
    orgId,
    actorType: 'user',
    actorId: by.userId,
    action: 'developer_sandbox.try_revoke',
    targetType: 'org',
    targetId: orgId,
  });
  const [bumped] = await g.commit();
  return (bumped?.results.length ?? 0) > 0;
}

/** The funnel columns a step may stamp; each is set once, by the trigger as well as by the `IS NULL` below. */
export type FunnelColumn =
  | 'quickstart_viewed_at'
  | 'first_call_at'
  | 'first_pass_at'
  | 'first_preview_at';

/**
 * `platform.job.developer_sandbox.funnel`: stamps funnel columns of the person's open sandbox, each only while it is
 * still empty, and says which landed. The person's live session is checked in the same batch. Writes no audit row: a funnel stamp is
 * product telemetry, not an act on the organization.
 */
export async function stampFunnel(
  ctx: ServiceContext,
  orgId: string,
  by: { userId: string; sessionIdHash: string },
  stamps: Partial<Record<FunnelColumn, number>>,
): Promise<Set<FunnelColumn>> {
  const entries = Object.entries(stamps) as [FunnelColumn, number][];
  if (entries.length === 0) return new Set();
  const now = ctx.clock.now();
  const live = rawCheck(
    'actor',
    `EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.user_id = ? AND u.status = 'active' AND s.revoked_at IS NULL
        AND s.expires_at > ? AND s.idle_expires_at > ? AND s.amr IN ${STRONG_AMR_SQL})`,
    [by.sessionIdHash, by.userId, now, now],
  );
  const g = developerSandboxGrant(ctx, 'platform.job.developer_sandbox.funnel', [live], orgId);
  for (const [column, at] of entries)
    g.update('developer_sandboxes', {
      set: { [column]: at },
      where: { org_id: orgId, user_id: by.userId, closed_at: null, [column]: null },
      returning: ['id'],
    });
  const results = await g.commit();
  // The columns this call set: a racing call that lost finds its column already full and lands nothing.
  return new Set(entries.filter((_, i) => (results[i]?.results.length ?? 0) > 0).map(([c]) => c));
}
