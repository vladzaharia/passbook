import { WORKBENCH_ROUTES } from '../../../shared/contracts/workbench.ts';
import { WORKBENCH_ROUTE_COPY } from '../../../shared/copy/workbench-errors.ts';
import type {
  ApiKeyAuth,
  ApiKeyStore,
  KeyCaller,
  SessionAuth,
  WorkbenchStore,
} from '../../platform/auth.ts';
import { TRY_TOKEN_PREFIX } from '../../platform/browser-signals.ts';
import { type Clock, systemClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { workbenchTestOnly } from '../../platform/errors.ts';
import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import { parseRoles } from '../../platform/json-column.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import { keyAuthOf } from '../api-keys/service.ts';
import { tryTokenKeyRow } from '../developer/repo-try.ts';
import { resolveTryToken } from '../developer/try-token.ts';
import { SHARED_WRITES } from './inventory.ts';
import { memberTokenRow, sandboxPersonRow } from './repo.ts';
import { tokenBucket, verifyWorkbenchToken, type WorkbenchClaims } from './token.ts';

const ALLOWED: ReadonlySet<string> = new Set(WORKBENCH_ROUTES);

/**
 * Bound to the browser, as the v1 try token is: the request carries the session cookie the token was made
 * for. A token copied off the page (a pasted curl, a HAR file) is no use without that cookie.
 */
async function cookieOk(caller: KeyCaller, sessionIdHash: string): Promise<boolean> {
  const cookie = caller.sessionCookie;
  return !!cookie && safeEqual(await sha256Hex(cookie), sessionIdHash);
}

/** The sandbox key a `sandbox_key` token stands for, while the session, sandbox generation and key hold. */
async function sandboxPrincipal(
  env: AppEnv,
  clock: Clock,
  claims: WorkbenchClaims,
  caller: KeyCaller | undefined,
  options: { limited?: 'ok' } | undefined,
): Promise<ApiKeyAuth | null> {
  const row = await tryTokenKeyRow(
    env.DB,
    { keyId: claims.ref, sessionIdHash: claims.sessionIdHash, generation: claims.generation },
    clock.now(),
  );
  if (!row || row.org_id !== claims.orgId) return null;
  const auth = await keyAuthOf(env, clock, row, caller, options);
  if (!auth) return null;
  const person = await sandboxPerson(
    env,
    claims,
    row.membership_id,
    row.session_auth_time,
    row.session_amr,
  );
  return {
    ...auth,
    // The one scope a sandbox's person holds beyond its key: managing the keys under it. The key routes
    // reach children only, cap them (`api-keys/workbench-cap.ts`) and never the token's own key (404).
    scopes: auth.scopes.includes('api-keys:write')
      ? auth.scopes
      : [...auth.scopes, 'api-keys:write'],
    via: 'try',
    sessionAuthTime: row.session_auth_time,
    sessionAmr: row.session_amr,
    workbench: {
      orgId: claims.orgId,
      subject: 'sandbox_key',
      keyId: claims.ref,
      ...(person ? { person } : {}),
    },
  };
}

/**
 * The sandbox person's Test session in their own org, for the key routes: managing a sandbox's keys is what the
 * person does as the org's admin, so it runs on their membership like a member token, under the same cap. The
 * person is the one the token's session names; a revoked membership or session leaves none (the routes refuse).
 */
async function sandboxPerson(
  env: AppEnv,
  claims: WorkbenchClaims,
  membershipId: string | null,
  authTime: number | null,
  amr: SessionAuth['amr'],
): Promise<SessionAuth | null> {
  if (!membershipId) return null;
  const row = await sandboxPersonRow(env.DB, claims.orgId, membershipId, claims.sessionIdHash);
  if (!row) return null;
  const roles = parseRoles(row.roles).filter((role) => role !== 'admin');
  if (roles.length === 0) return null;
  return {
    kind: 'session',
    userId: row.user_id,
    sessionId: claims.sessionIdHash,
    roles,
    csrfSecret: '',
    amr,
    authTime,
    mode: 'test',
    via: 'try',
    // Carries the sandbox key's id: the key routes refuse it (404) as they do for the token itself.
    workbench: { orgId: claims.orgId, subject: 'member', keyId: claims.ref },
  };
}

/** The member's session in the org's Test mode, while the session, membership and epoch hold. Never a platform admin. */
async function memberPrincipal(
  env: AppEnv,
  clock: Clock,
  claims: WorkbenchClaims,
): Promise<SessionAuth | null> {
  const row = await memberTokenRow(
    env.DB,
    {
      orgId: claims.orgId,
      membershipId: claims.ref,
      sessionIdHash: claims.sessionIdHash,
      generation: claims.generation,
    },
    clock.now(),
  );
  if (!row) return null;
  // A token is never a platform admin; an admin keeps the console group their role implied.
  const stored = parseRoles(row.roles);
  const roles = stored.filter((role) => role !== 'admin');
  if (stored.includes('admin') && !roles.includes('console')) roles.push('console');
  if (roles.length === 0) return null;
  return {
    kind: 'session',
    userId: row.user_id,
    sessionId: claims.sessionIdHash,
    roles,
    // The bearer is the credential: it is not ambient, so no CSRF secret applies.
    csrfSecret: '',
    amr: row.amr,
    authTime: row.auth_time,
    mode: 'test',
    via: 'try',
    workbench: { orgId: claims.orgId, subject: 'member' },
  };
}

/** Deny by default: every route the request matched must be on the allowlist (`x-workbench: test`). */
const routeAllowed = (caller: KeyCaller | undefined): boolean =>
  !!caller?.routes?.length && caller.routes.every((route) => ALLOWED.has(route));

/**
 * A `pbtry_` token's principal: the sandbox key (v1, or a v2 `sandbox_key`) or a member's Test session (v2
 * `member`). Null for a token that is unknown, expired or no longer bound; 403 `WORKBENCH_TEST_ONLY` for a
 * live one asking for Live, or a member token on a route it may not call.
 */
export async function resolveWorkbenchToken(
  env: AppEnv,
  clock: Clock,
  raw: string,
  caller: KeyCaller | undefined,
  options: { limited?: 'ok' } | undefined,
): Promise<ApiKeyAuth | SessionAuth | null> {
  const claims = await verifyWorkbenchToken(env, raw);
  let auth: ApiKeyAuth | SessionAuth | null;
  if (!claims) {
    auth = await resolveTryToken(env, clock, raw, caller, options);
  } else {
    // A guard that passes no caller (the legacy key guards) never takes a token.
    if (
      !caller ||
      claims.expiresAt <= clock.now() ||
      !(await cookieOk(caller, claims.sessionIdHash))
    )
      return null;
    await enforceRateLimit(env, 'RL_API_TRY', tokenBucket(claims.sessionIdHash));
    auth =
      claims.subject === 'sandbox_key'
        ? await sandboxPrincipal(env, clock, claims, caller, options)
        : await memberPrincipal(env, clock, claims);
  }
  if (!auth) return null;
  if (caller?.mode === 'live') throw workbenchTestOnly();
  if (auth.kind === 'session' && !routeAllowed(caller))
    throw workbenchTestOnly(WORKBENCH_ROUTE_COPY);
  // Every token, the sandbox's too: no write to state the org's Live shares (brand, org, members, settings).
  if (caller?.routes?.some((route) => SHARED_WRITES.test(route)))
    throw workbenchTestOnly(WORKBENCH_ROUTE_COPY);
  return auth;
}

/** The store `requireCaller` sends `pbtry_` bearers to. */
export function createWorkbenchStore(env: AppEnv, clock: Clock = systemClock): WorkbenchStore {
  return {
    resolve: (raw, caller, options) => resolveWorkbenchToken(env, clock, raw, caller, options),
  };
}

/**
 * The key store for every other key guard: a `pbtry_` bearer resolves here to the sandbox key it stands for,
 * anything else in `inner`. A member token is no key, so these guards refuse it (403 `WORKBENCH_TEST_ONLY`).
 */
export function withWorkbenchTokens(
  env: AppEnv,
  inner: ApiKeyStore,
  clock: Clock = systemClock,
): ApiKeyStore {
  return {
    async resolve(raw, caller, options) {
      if (!raw.startsWith(TRY_TOKEN_PREFIX)) return inner.resolve(raw, caller, options);
      const auth = await resolveWorkbenchToken(env, clock, raw, caller, options);
      if (auth?.kind === 'session') throw workbenchTestOnly(WORKBENCH_ROUTE_COPY);
      return auth;
    },
  };
}
