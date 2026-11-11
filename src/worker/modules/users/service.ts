import type { z } from 'zod';
import type {
  SignInMethodSchema,
  UserDetailSchema,
  UserListQuerySchema,
  UserSchema,
  UserSummarySchema,
} from '../../../shared/contracts/index.ts';
import type { Role } from '../../platform/auth.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import { parseJsonArray, parseRoles } from '../../platform/json-column.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { emailsOf } from '../auth/repo.ts';
import { BREAKGLASS_PROVIDER, OIDC_PROVIDER } from '../auth/service.ts';
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
    primaryEmail: row.primary_email,
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

export async function listUsers(ctx: ServiceContext, query: z.infer<typeof UserListQuerySchema>) {
  const rows = await repo.listUsers(ctx.env.DB, query);
  const page = rows.slice(0, query.limit);
  const facts = await repo.factsFor(
    ctx.env.DB,
    page.map((r) => r.id),
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
): Promise<UserDetailDto> {
  const db = ctx.env.DB;
  const user = await requireUser(ctx, id);
  const [emails, identities, sessions, passes, passCount, audit, facts] = await Promise.all([
    emailsOf(db, id),
    repo.identitiesOf(db, id),
    repo.listRecentSessions(db, id),
    repo.ownedPasses(db, id),
    repo.ownedPassCount(db, id),
    repo.recentAudit(db, id),
    repo.factsFor(db, [id]),
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
      title: p.title,
      templateName: p.template_name,
      orgName: p.org_name,
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

export async function setUserStatus(
  ctx: ServiceContext,
  actorId: string,
  id: string,
  status: 'active' | 'disabled',
  adminSessionId?: string,
): Promise<UserDto> {
  const user = await requireUser(ctx, id);
  if (status === 'disabled' && id === actorId) {
    throw new ConflictError('You cannot disable your own account.', 'SELF_DISABLE');
  }
  const changed = adminSessionId
    ? await repo.setStatusAsAdmin(ctx, id, status, { userId: actorId, sessionId: adminSessionId })
    : await repo.setStatus(ctx.env.DB, id, status, ctx.clock.now());
  if (changed) {
    await recordAudit(ctx, {
      actorType: 'user',
      actorId,
      action: status === 'disabled' ? 'user.disable' : 'user.enable',
      targetType: 'user',
      targetId: id,
    });
  }
  return toUser({ ...user, status });
}
