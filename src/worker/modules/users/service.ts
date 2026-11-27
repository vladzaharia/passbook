import type { z } from 'zod';
import type {
  SignInMethodSchema,
  UserDetailSchema,
  UserListQuerySchema,
  UserSchema,
  UserSummarySchema,
} from '../../../shared/contracts/index.ts';
import { knownEmail } from '../../../shared/email.ts';
import { callerActor, type PlatformCaller } from '../../platform/actor.ts';
import type { Role } from '../../platform/auth.ts';
import { ConflictError, NotFoundError, PersonRequiredError } from '../../platform/errors.ts';
import { parseJsonArray, parseRoles } from '../../platform/json-column.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { BREAKGLASS_PROVIDER } from '../auth/breakglass-service.ts';
import { emailsOf } from '../auth/repo.ts';
import { OIDC_PROVIDER } from '../auth/service.ts';
import { isLiveAdmin } from '../idp/platform-admin.ts';
import { viewerOrgName } from '../orgs/personal-names.ts';
import { suspendPersonalOrgOf } from '../orgs/personal-suspend.ts';
import { personalOrgIdOf } from '../orgs/repo-personal.ts';
import * as repo from './repo.ts';

export type UserDto = z.infer<typeof UserSchema>;
export type UserSummaryDto = z.infer<typeof UserSummarySchema>;
export type UserDetailDto = z.infer<typeof UserDetailSchema>;
type SignInMethod = z.infer<typeof SignInMethodSchema>;

const METHOD_LABEL: Record<SignInMethod, string> = {
  oidc: 'Polaris ID',
  magic_link: 'Email link',
  breakglass: 'Break-glass',
};

const asRoles = (raw: string): Role[] => parseRoles(raw);

function toUser(row: repo.UserRow): UserDto {
  return {
    id: row.id,
    name: row.name,
    primaryEmail: knownEmail(row.primary_email),
    status: row.status,
    lastRoles: asRoles(row.last_roles),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

/** Polaris ID first, then the email link, then break-glass. */
function methodsOf(facts: repo.UserFacts | undefined): SignInMethod[] {
  const providers = new Set((facts?.providers ?? '').split(',').filter(Boolean));
  const out: SignInMethod[] = [];
  if (providers.has(OIDC_PROVIDER)) out.push('oidc');
  if (facts?.has_email) out.push('magic_link');
  if (providers.has(BREAKGLASS_PROVIDER)) out.push('breakglass');
  return out;
}

export async function listUsers(
  ctx: ServiceContext,
  query: z.infer<typeof UserListQuerySchema>,
  viewerId = '',
) {
  const rows = await repo.listUsers(ctx.env.DB, query);
  const page = rows.slice(0, query.limit);
  const facts = await repo.factsFor(
    ctx.env.DB,
    page.map((r) => r.id),
    viewerId,
  );
  return {
    items: page.map(
      (row): UserSummaryDto => ({
        ...toUser(row),
        passCount: facts.get(row.id)?.pass_count ?? 0,
        signInMethods: methodsOf(facts.get(row.id)),
      }),
    ),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function requireUser(ctx: ServiceContext, id: string): Promise<repo.UserRow> {
  const user = await repo.getUser(ctx.env.DB, id);
  if (!user) throw new NotFoundError('User not found.', 'USER_NOT_FOUND');
  return user;
}

/** `currentSessionId` marks the requester's own session row. */
export async function getUserDetail(
  ctx: ServiceContext,
  id: string,
  currentSessionId = '',
  viewerId = '',
): Promise<UserDetailDto> {
  const db = ctx.env.DB;
  const user = await requireUser(ctx, id);
  const [emails, identities, sessions, passes, passCount, audit, facts] = await Promise.all([
    emailsOf(db, id),
    repo.identitiesOf(db, id),
    repo.listRecentSessions(db, id),
    repo.ownedPasses(db, id, viewerId),
    repo.ownedPassCount(db, id, viewerId),
    repo.recentAudit(db, id),
    repo.factsFor(db, [id], viewerId),
  ]);
  return {
    ...toUser(user),
    signInMethods: methodsOf(facts.get(id)),
    emails: emails.map((e) => ({
      email: e.email,
      verifiedVia: e.verified_via,
      verifiedAt: e.verified_at,
    })),
    identities: identities.map((i) => ({
      provider: i.provider,
      subject: i.subject,
      emailClaim: i.email_claim,
      emailVerified: i.email_verified === 1,
      groups: parseJsonArray(i.groups, 'groups', (g): g is string => typeof g === 'string'),
      lastUsedAt: i.last_used_at,
    })),
    sessions: sessions.map((s) => ({
      id: s.id_hash,
      amr: s.amr,
      roles: asRoles(s.roles),
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: Math.min(s.expires_at, s.idle_expires_at),
      revokedAt: s.revoked_at,
      userAgent: s.user_agent,
      current: s.id_hash === currentSessionId,
      method: METHOD_LABEL[s.amr],
    })),
    passes: passes.map((p) => ({
      id: p.id,
      templateName: p.template_name,
      orgName: viewerOrgName(p, viewerId),
      status: p.status,
    })),
    passCount,
    recentAudit: audit.map((a) => ({
      id: a.id,
      at: a.at,
      action: a.action,
      actorType: a.actor_type,
      actorId: a.actor_id,
    })),
  };
}

/** A key never acts on a platform admin: signing out or disabling the people who would revoke it is a person's call. */
export async function refuseAdminTargetForKey(
  ctx: ServiceContext,
  who: PlatformCaller,
  user: repo.UserRow,
): Promise<void> {
  if (who.userId === null && (await isLiveAdmin(ctx, user.id, user.last_roles)))
    throw new ConflictError(
      'Platform admins hold every role. Change it in Polaris ID.',
      'IDP_PLATFORM_ADMIN',
    );
}

export async function setUserStatus(
  ctx: ServiceContext,
  who: PlatformCaller,
  id: string,
  status: 'active' | 'disabled',
): Promise<UserDto> {
  const user = await requireUser(ctx, id);
  await refuseAdminTargetForKey(ctx, who, user);
  if (status === 'disabled' && id === who.userId) {
    throw new ConflictError('You cannot disable your own account.', 'SELF_DISABLE');
  }
  // Disabling suspends a personal org, which is a person's call (P3): refuse before anything changes.
  if (status === 'disabled' && who.userId === null && (await personalOrgIdOf(ctx.env.DB, id)))
    throw new PersonRequiredError();
  const changed = await repo.setStatusAsAdmin(ctx, id, status, who);
  if (changed) {
    const actor = callerActor(who);
    await recordAudit(ctx, {
      actorType: actor.type,
      actorId: actor.id,
      action: status === 'disabled' ? 'user.disable' : 'user.enable',
      targetType: 'user',
      targetId: id,
    });
    if (status === 'disabled') await suspendPersonalOrgOf(ctx, actor, id, who);
  }
  return toUser({ ...user, status });
}
