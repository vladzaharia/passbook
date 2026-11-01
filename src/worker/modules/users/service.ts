import type { z } from 'zod';
import type {
  UserDetailSchema,
  UserListQuerySchema,
  UserSchema,
} from '../../../shared/contracts/index.ts';
import { strictEmail } from '../../../shared/email.ts';
import type { Role } from '../../platform/auth.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { emailsOf, addUserEmail as insertUserEmail } from '../auth/repo.ts';
import { revokeAllForUser } from '../auth/sessions.ts';
import { attachWaitingPassesForEmail } from '../holders/service.ts';
import * as repo from './repo.ts';

export type UserDto = z.infer<typeof UserSchema>;
export type UserDetailDto = z.infer<typeof UserDetailSchema>;

const asRoles = (raw: string): Role[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((r): r is Role => r === 'admin' || r === 'user')
      : [];
  } catch {
    return [];
  }
};

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

function groupsOf(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    return [];
  }
}

export async function listUsers(ctx: ServiceContext, query: z.infer<typeof UserListQuerySchema>) {
  const rows = await repo.listUsers(ctx.env.DB, query);
  const page = rows.slice(0, query.limit);
  return {
    items: page.map(toUser),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

async function requireUser(ctx: ServiceContext, id: string): Promise<repo.UserRow> {
  const user = await repo.getUser(ctx.env.DB, id);
  if (!user) throw new NotFoundError('User not found.', 'USER_NOT_FOUND');
  return user;
}

export async function getUserDetail(ctx: ServiceContext, id: string): Promise<UserDetailDto> {
  const db = ctx.env.DB;
  const user = await requireUser(ctx, id);
  const [emails, identities, sessions, passes, passCount, audit] = await Promise.all([
    emailsOf(db, id),
    repo.identitiesOf(db, id),
    repo.listRecentSessions(db, id),
    repo.ownedPasses(db, id),
    repo.ownedPassCount(db, id),
    repo.recentAudit(db, id),
  ]);
  return {
    ...toUser(user),
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
      groups: groupsOf(i.groups),
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
): Promise<UserDto> {
  const user = await requireUser(ctx, id);
  if (status === 'disabled' && id === actorId) {
    throw new ConflictError('You cannot disable your own account.', 'SELF_DISABLE');
  }
  if (user.status !== status) {
    await repo.setStatus(ctx.env.DB, id, status);
    if (status === 'disabled') await revokeAllForUser(ctx, id);
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

function parseEmail(raw: string): string {
  const email = strictEmail(raw);
  if (!email) throw new ValidationError('Enter a valid email address.', [], 'INVALID_EMAIL');
  return email;
}

export async function addVerifiedEmail(
  ctx: ServiceContext,
  actorId: string,
  id: string,
  rawEmail: string,
): Promise<UserDetailDto> {
  const email = parseEmail(rawEmail);
  await requireUser(ctx, id);
  const { ownerId, added } = await insertUserEmail(ctx.env.DB, email, id, 'admin', ctx.clock.now());
  if (ownerId !== id) {
    throw new ConflictError('That address belongs to another account.', 'EMAIL_TAKEN');
  }
  if (added) {
    await recordAudit(ctx, {
      actorType: 'user',
      actorId,
      action: 'user.email_add',
      targetType: 'user',
      targetId: id,
    });
    await attachWaitingPassesForEmail(ctx, id, email);
  }
  return getUserDetail(ctx, id);
}

export async function removeEmail(
  ctx: ServiceContext,
  actorId: string,
  id: string,
  rawEmail: string,
): Promise<UserDetailDto> {
  const email = parseEmail(rawEmail);
  const user = await requireUser(ctx, id);
  if (user.primary_email === email) {
    throw new ConflictError('The primary email cannot be removed.', 'PRIMARY_EMAIL');
  }
  if (!(await repo.removeEmail(ctx.env.DB, id, email))) {
    throw new NotFoundError('Email not found.', 'EMAIL_NOT_FOUND');
  }
  await recordAudit(ctx, {
    actorType: 'user',
    actorId,
    action: 'user.email_remove',
    targetType: 'user',
    targetId: id,
  });
  return getUserDetail(ctx, id);
}

export async function revokeUserSessions(
  ctx: ServiceContext,
  actorId: string,
  id: string,
): Promise<number> {
  await requireUser(ctx, id);
  const count = await revokeAllForUser(ctx, id);
  await recordAudit(ctx, {
    actorType: 'user',
    actorId,
    action: 'user.sessions_revoke',
    targetType: 'user',
    targetId: id,
    detail: { count },
  });
  return count;
}
