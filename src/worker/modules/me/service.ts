import type { z } from 'zod';
import type { MyPassSchema } from '../../../shared/contracts/index.ts';
import { strictEmail } from '../../../shared/email.ts';
import { baseUrl } from '../../platform/env.ts';
import {
  ConflictError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from '../../platform/errors.ts';
import { checkRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { issueMagicLink } from '../auth/magic-service.ts';
import { findUserByEmail, findUserByPrimaryEmail } from '../auth/repo.ts';
import { revokeAllForUser, revokeOne } from '../auth/sessions.ts';
import { removePassFromUser } from '../holders/service.ts';
import { requestRefresh } from '../passes/service.ts';
import * as repo from './repo.ts';

export type MyPassDto = z.infer<typeof MyPassSchema>;

/** Seams from other modules, injectable for tests. */
export interface MeDeps {
  requestRefresh: typeof requestRefresh;
  removePassFromUser: typeof removePassFromUser;
}
const defaultDeps: MeDeps = { requestRefresh, removePassFromUser };

function parsePassJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toPass(ctx: ServiceContext, row: repo.MyPassRow): MyPassDto {
  const base = `${baseUrl(ctx.env)}/p/${row.download_token}`;
  return {
    id: row.id,
    title: row.display_title,
    subtitle: row.display_subtitle,
    templateName: row.template_name,
    orgName: row.org_name,
    status: row.status,
    modifiedAt: row.modified_at,
    lastRefreshedAt: row.last_refreshed_at,
    refreshRequestedAt: row.refresh_requested_at,
    downloadUrl: `${base}/pass.pkpass`,
    passJson: parsePassJson(row.pass_json),
    assetBaseUrl: `${base}/assets/`,
  };
}

export async function listMyPasses(
  ctx: ServiceContext,
  userId: string,
  query: { cursor?: string; limit: number },
) {
  const rows = await repo.listMyPasses(ctx.env.DB, userId, query.cursor, query.limit);
  const page = rows.slice(0, query.limit);
  return {
    items: page.map((row) => toPass(ctx, row)),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

async function ownedRow(ctx: ServiceContext, userId: string, passId: string) {
  const row = await repo.getMyPass(ctx.env.DB, userId, passId);
  if (!row) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return row;
}

export async function getMyPass(ctx: ServiceContext, userId: string, passId: string) {
  return toPass(ctx, await ownedRow(ctx, userId, passId));
}

export async function refreshMyPass(
  ctx: ServiceContext,
  userId: string,
  passId: string,
  deps: MeDeps = defaultDeps,
) {
  const row = await ownedRow(ctx, userId, passId);
  if (row.status === 'voided') throw new ConflictError('This pass is voided.', 'PASS_VOIDED');
  if (!(await checkRateLimit(ctx.env, 'RL_REFRESH', `refresh:${passId}`))) {
    throw new RateLimitedError();
  }
  const { requestedAt } = await deps.requestRefresh(ctx, passId, { type: 'user', id: userId });
  return { accepted: true as const, requestedAt };
}

export async function removeMyPass(
  ctx: ServiceContext,
  userId: string,
  passId: string,
  deps: MeDeps = defaultDeps,
) {
  await ownedRow(ctx, userId, passId);
  await deps.removePassFromUser(ctx, passId, userId);
  await recordAudit(ctx, {
    actorType: 'user',
    actorId: userId,
    action: 'pass.remove_from_user',
    targetType: 'pass',
    targetId: passId,
  });
  return { ok: true as const };
}

export async function listMyEmails(ctx: ServiceContext, userId: string) {
  const [user, emails] = await Promise.all([
    repo.getUser(ctx.env.DB, userId),
    repo.emailsOf(ctx.env.DB, userId),
  ]);
  return {
    items: emails.map((e) => ({
      email: e.email,
      verifiedAt: e.verified_at,
      verifiedVia: e.verified_via,
      primary: e.email === user?.primary_email,
    })),
  };
}

/** Sends a verification link. Silent when the address already belongs to someone else. */
export async function addMyEmail(ctx: ServiceContext, userId: string, rawEmail: string) {
  const email = strictEmail(rawEmail);
  if (!email) throw new ValidationError('Enter a valid email address.', [], 'INVALID_EMAIL');
  if (!(await checkRateLimit(ctx.env, 'RL_MAGIC_LINK', `verify:${userId}`))) {
    throw new RateLimitedError();
  }
  const owner =
    (await findUserByEmail(ctx.env.DB, email)) ?? (await findUserByPrimaryEmail(ctx.env.DB, email));
  if (owner && owner.id !== userId) {
    ctx.log.info('me.email_add_taken', { userId });
    return { ok: true as const };
  }
  await issueMagicLink(ctx, {
    email,
    purpose: 'verify_email',
    userId,
    bindingHash: null,
    next: '/account',
  });
  return { ok: true as const };
}

export async function removeMyEmail(ctx: ServiceContext, userId: string, rawEmail: string) {
  const email = strictEmail(rawEmail);
  if (!email) throw new ValidationError('Enter a valid email address.', [], 'INVALID_EMAIL');
  const user = await repo.getUser(ctx.env.DB, userId);
  if (user?.primary_email === email) {
    throw new ConflictError('The primary email cannot be removed.', 'PRIMARY_EMAIL');
  }
  if (!(await repo.removeEmail(ctx.env.DB, userId, email))) {
    throw new NotFoundError('Email not found.', 'EMAIL_NOT_FOUND');
  }
  await recordAudit(ctx, {
    actorType: 'user',
    actorId: userId,
    action: 'user.email_remove',
    targetType: 'user',
    targetId: userId,
  });
  return listMyEmails(ctx, userId);
}

export async function listMySessions(ctx: ServiceContext, userId: string, currentId: string) {
  const rows = await repo.listLiveSessions(ctx.env.DB, userId, ctx.clock.now());
  return {
    items: rows.map((s) => ({
      id: s.id_hash,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      userAgent: s.user_agent,
      current: s.id_hash === currentId,
    })),
  };
}

export async function revokeMySession(ctx: ServiceContext, userId: string, sessionId: string) {
  const row = await repo.getSession(ctx.env.DB, sessionId);
  if (!row || row.user_id !== userId)
    throw new NotFoundError('Session not found.', 'SESSION_NOT_FOUND');
  await revokeOne(ctx, sessionId);
  await recordAudit(ctx, {
    actorType: 'user',
    actorId: userId,
    action: 'session.revoke',
    targetType: 'user',
    targetId: userId,
  });
  return { ok: true as const };
}

export async function revokeAllMySessions(ctx: ServiceContext, userId: string) {
  const count = await revokeAllForUser(ctx, userId);
  await recordAudit(ctx, {
    actorType: 'user',
    actorId: userId,
    action: 'user.sessions_revoke',
    targetType: 'user',
    targetId: userId,
    detail: { count },
  });
  return { ok: true as const };
}
