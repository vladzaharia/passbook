import type { z } from 'zod';
import { PackageLimitError, packagePasses } from '../../../passkit/index.ts';
import { MY_PASSES_BUNDLE_SIZE, type MyPassSchema } from '../../../shared/contracts/index.ts';
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
import { withinVerifyUserCap } from '../auth/magic-caps.ts';
import { processVerifyRequest } from '../auth/magic-service.ts';
import { revokeAllForUser, revokeOne } from '../auth/sessions.ts';
import { removePassFromUser } from '../holders/service.ts';
import { assetNamesOf } from '../passes/detail.ts';
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Server-owned: the Apple device token must never reach the client.
    const { authenticationToken: _token, ...safe } = parsed as Record<string, unknown>;
    return safe;
  } catch {
    return {};
  }
}

async function toPass(ctx: ServiceContext, row: repo.MyPassRow): Promise<MyPassDto> {
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
    assetNames: await assetNamesOf(ctx, {
      id: row.id,
      orgId: row.org_id,
      templateId: row.template_id,
      templateVersion: row.template_version,
    }),
    inWallet: row.registered === 1,
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
    items: await Promise.all(page.map((row) => toPass(ctx, row))),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

async function ownedRow(ctx: ServiceContext, userId: string, passId: string) {
  const row = await repo.getMyPass(ctx.env.DB, userId, passId);
  if (!row) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return row;
}

export async function getMyPass(ctx: ServiceContext, userId: string, passId: string) {
  return await toPass(ctx, await ownedRow(ctx, userId, passId));
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
  const { requestedAt, cooldownSeconds } = await deps.requestRefresh(ctx, passId, {
    type: 'user',
    id: userId,
  });
  return { accepted: true as const, requestedAt, cooldownSeconds };
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
  const items = emails.map((e) => ({
    email: e.email,
    verifiedAt: e.verified_at as number | null,
    verifiedVia: e.verified_via as 'magic_link' | 'oidc' | 'admin' | null,
    primary: e.email === user?.primary_email,
  }));
  // The profile address can be unproven (OIDC without trusted email). Listed so it can be verified;
  // it is never in user_emails, so nothing that matches on verified emails sees it.
  if (user && !items.some((e) => e.primary)) {
    items.push({ email: user.primary_email, verifiedAt: null, verifiedVia: null, primary: true });
  }
  return { items };
}

/**
 * Asks for a verification link. The answer never depends on the address, and the lookup and send
 * run after it, so neither the body nor the latency reveals who is registered.
 */
export async function addMyEmail(ctx: ServiceContext, userId: string, rawEmail: string) {
  const email = strictEmail(rawEmail);
  if (!email) throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  if (!(await checkRateLimit(ctx.env, 'RL_MAGIC_LINK', `verify:${userId}`))) {
    throw new RateLimitedError();
  }
  if (!(await withinVerifyUserCap(ctx, userId))) throw new RateLimitedError();
  ctx.waitUntil(processVerifyRequest(ctx, { userId, email }));
  return { ok: true as const };
}

export async function removeMyEmail(ctx: ServiceContext, userId: string, rawEmail: string) {
  const email = strictEmail(rawEmail);
  if (!email) throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
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

/** Sign-in emails go to another of my verified addresses. */
export async function makeMyEmailPrimary(ctx: ServiceContext, userId: string, rawEmail: string) {
  const email = strictEmail(rawEmail);
  if (!email) throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  if (!(await repo.setPrimaryEmail(ctx.env.DB, userId, email))) {
    throw new NotFoundError('Email not found.', 'EMAIL_NOT_FOUND');
  }
  await recordAudit(ctx, {
    actorType: 'user',
    actorId: userId,
    action: 'user.email_primary',
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

const BUNDLE_NOT_FOUND = () => new NotFoundError('No passes to bundle.', 'BUNDLE_EMPTY');

/** Signed .pkpass objects of my active passes, `MY_PASSES_BUNDLE_SIZE` per part. */
export async function myPassesBundle(ctx: ServiceContext, userId: string, part: number) {
  const total = await repo.countBundlePasses(ctx.env.DB, userId);
  const parts = Math.ceil(total / MY_PASSES_BUNDLE_SIZE);
  if (part > parts) throw BUNDLE_NOT_FOUND();
  const rows = await repo.listBundlePasses(
    ctx.env.DB,
    userId,
    MY_PASSES_BUNDLE_SIZE,
    (part - 1) * MY_PASSES_BUNDLE_SIZE,
  );
  if (rows.length === 0) throw BUNDLE_NOT_FOUND();
  try {
    const body = packagePasses(
      rows.map((row) => ({
        name: row.id,
        ...(row.object_size ? { size: row.object_size } : {}),
        bytes: async () => {
          const object = await ctx.env.BUCKET.get(row.object_key);
          if (!object) throw new NotFoundError('A pass file is missing.', 'PASS_FILE_MISSING');
          return new Uint8Array(await object.arrayBuffer());
        },
      })),
    );
    return { body, parts };
  } catch (error) {
    if (error instanceof PackageLimitError) {
      throw new ConflictError(
        'The bundle is too large. Add passes one by one.',
        'BUNDLE_TOO_LARGE',
      );
    }
    throw error;
  }
}
