import type { Amr, Role, SessionAuth, SessionStore } from '../../platform/auth.ts';
import { type Clock, systemClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { parseRoles } from '../../platform/json-column.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import * as repo from './repo-sessions.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface SessionLifetime {
  idleMs: number;
  absoluteMs: number;
  /** Minimum gap between `last_seen_at` writes. */
  touchEveryMs: number;
}

export function lifetimeFor(roles: readonly Role[], amr?: Amr): SessionLifetime {
  if (amr === 'breakglass')
    return { idleMs: 30 * MINUTE, absoluteMs: 4 * HOUR, touchEveryMs: MINUTE };
  return roles.includes('admin')
    ? { idleMs: HOUR, absoluteMs: 12 * HOUR, touchEveryMs: MINUTE }
    : { idleMs: 30 * DAY, absoluteMs: 90 * DAY, touchEveryMs: 5 * MINUTE };
}

export const hashSessionCookie = (cookieValue: string) => sha256Hex(cookieValue);

export interface NewSession {
  cookieValue: string;
  idHash: string;
  csrfSecret: string;
  maxAgeSeconds: number;
}

/** Always a fresh id: callers revoke any presented session first (fixation). */
export async function createSession(
  ctx: ServiceContext,
  input: {
    userId: string;
    roles: Role[];
    amr: Amr;
    ipPrefix: string | null;
    userAgent: string | null;
  },
): Promise<NewSession> {
  const now = ctx.clock.now();
  const life = lifetimeFor(input.roles, input.amr);
  const cookieValue = ctx.ids.token(32);
  const idHash = await hashSessionCookie(cookieValue);
  const csrfSecret = ctx.ids.token(32);
  await repo.insertSession(ctx.env.DB, {
    idHash,
    userId: input.userId,
    amr: input.amr,
    roles: input.roles,
    csrfSecret,
    now,
    idleExpiresAt: now + life.idleMs,
    expiresAt: now + life.absoluteMs,
    ipPrefix: input.ipPrefix,
    userAgent: input.userAgent?.slice(0, 256) ?? null,
  });
  return { cookieValue, idHash, csrfSecret, maxAgeSeconds: Math.floor(life.absoluteMs / 1000) };
}

export interface ResolvedSession extends SessionAuth {
  expiresAt: number;
}

export async function resolveSession(
  env: Pick<AppEnv, 'DB'>,
  clock: Clock,
  cookieValue: string,
): Promise<ResolvedSession | null> {
  if (!cookieValue || cookieValue.length > 256) return null;
  const idHash = await hashSessionCookie(cookieValue);
  const row = await repo.getSession(env.DB, idHash);
  if (!row || row.revoked_at !== null || row.user_status !== 'active') return null;
  const now = clock.now();
  if (now >= row.expires_at || now >= row.idle_expires_at) return null;
  const roles = parseRoles(row.roles);
  if (roles.length === 0) return null;
  const life = lifetimeFor(roles, row.amr);
  if (now - row.last_seen_at >= life.touchEveryMs) {
    await repo.touchSession(env.DB, idHash, now, life.idleMs);
  }
  return {
    kind: 'session',
    userId: row.user_id,
    sessionId: idHash,
    roles,
    csrfSecret: row.csrf_secret,
    amr: row.amr,
    mode: 'live',
    expiresAt: Math.min(row.expires_at, row.idle_expires_at),
  };
}

export function createSessionStore(env: AppEnv, clock: Clock = systemClock): SessionStore {
  return { resolve: (cookieValue) => resolveSession(env, clock, cookieValue) };
}

export const revokeOne = (ctx: ServiceContext, idHash: string) =>
  repo.revokeSession(ctx.env.DB, idHash, ctx.clock.now());

export const revokeAllForUser = (ctx: ServiceContext, userId: string, exceptIdHash?: string) =>
  repo.revokeUserSessions(ctx.env.DB, userId, ctx.clock.now(), exceptIdHash);
