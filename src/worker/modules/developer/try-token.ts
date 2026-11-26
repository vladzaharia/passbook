import type { TryToken } from '../../../shared/contracts/index.ts';
import { SANDBOX_KEY_MISSING_COPY } from '../../../shared/copy/developer.ts';
import type { ApiKeyAuth, KeyCaller, SessionAuth } from '../../platform/auth.ts';
import { TRY_TOKEN_PREFIX } from '../../platform/browser-signals.ts';
import type { Clock } from '../../platform/clock.ts';
import { derivedHmacKey, macPreviousVersion } from '../../platform/crypto.ts';
import type { AppEnv } from '../../platform/env.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import { fromBase64Url, safeEqual, sha256Hex, toBase64Url } from '../../platform/ids.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { keyAuthOf } from '../api-keys/service.ts';
import { sandboxOfUser } from './repo.ts';
import { bumpTryGeneration } from './repo-grants.ts';
import { tryKeyOf, tryTokenKeyRow } from './repo-try.ts';

/** How long a try token lives; the portal refreshes it at 12 minutes. */
export const TRY_TOKEN_TTL_MS = 15 * 60_000;
const LABEL = 'developer-try.v1';
const MAX_LENGTH = 512;
const SESSION_ID_HASH = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface TryClaims {
  keyId: string;
  sessionIdHash: string;
  generation: number;
  expiresAt: number;
}

async function mac(env: object, payload: string, version?: number): Promise<string> {
  const key = await derivedHmacKey(env, LABEL, version);
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`developer-try|${payload}`) as BufferSource,
  );
  return toBase64Url(new Uint8Array(signed));
}

/** `pbtry_<payload>.<mac>`: payload `v1:<keyId>:<sessionIdHash>:<generation>:<expiresAt>`, base64url. */
export async function signTryToken(env: object, claims: TryClaims): Promise<string> {
  const { keyId, sessionIdHash, generation, expiresAt } = claims;
  const payload = toBase64Url(
    encoder.encode(`v1:${keyId}:${sessionIdHash}:${generation}:${expiresAt}`),
  );
  return `${TRY_TOKEN_PREFIX}${payload}.${await mac(env, payload)}`;
}

/** `RL_API_TRY` counts per session, the token's binding, so a limit applies before any database read. */
const tryBucket = (sessionIdHash: string) => `RL_API_TRY:session:${sessionIdHash}`;

/** The claims of a token this deployment made (under the current MAC root or, mid-rotation, the previous one). */
export async function verifyTryToken(env: object, raw: string): Promise<TryClaims | null> {
  if (!raw.startsWith(TRY_TOKEN_PREFIX) || raw.length > MAX_LENGTH) return null;
  const [payload, presented, extra] = raw.slice(TRY_TOKEN_PREFIX.length).split('.');
  if (!payload || !presented || extra !== undefined) return null;
  const previous = macPreviousVersion(env);
  const valid =
    (await safeEqual(await mac(env, payload), presented)) ||
    (previous !== null && (await safeEqual(await mac(env, payload, previous), presented)));
  if (!valid) return null;
  // Only a payload this deployment made gets here, so it decodes.
  const text = decoder.decode(fromBase64Url(payload));
  const [version, keyId, sessionIdHash, generation, expiresAt] = text.split(':');
  if (version !== 'v1' || !keyId || !sessionIdHash || !SESSION_ID_HASH.test(sessionIdHash))
    return null;
  const claims = {
    keyId,
    sessionIdHash,
    generation: Number(generation),
    expiresAt: Number(expiresAt),
  };
  return Number.isSafeInteger(claims.generation) && Number.isSafeInteger(claims.expiresAt)
    ? claims
    : null;
}

/** The sandbox key's principal for a valid token whose session, key and sandbox all still hold; else null. */
export async function resolveTryToken(
  env: AppEnv,
  clock: Clock,
  raw: string,
  caller: KeyCaller | undefined,
  options: { limited?: 'ok' } | undefined,
): Promise<ApiKeyAuth | null> {
  const claims = await verifyTryToken(env, raw);
  const now = clock.now();
  if (!claims || claims.expiresAt <= now) return null;
  // Only beside the session cookie it was made for: a token copied off the page is no use elsewhere.
  const cookie = caller?.sessionCookie;
  if (!cookie || !(await safeEqual(await sha256Hex(cookie), claims.sessionIdHash))) return null;
  await enforceRateLimit(env, 'RL_API_TRY', tryBucket(claims.sessionIdHash));
  const row = await tryTokenKeyRow(env.DB, claims, now);
  if (!row) return null;
  const auth = await keyAuthOf(env, clock, row, caller, options);
  if (auth) {
    auth.via = 'try';
    auth.sessionAuthTime = row.session_auth_time;
    auth.sessionAmr = row.session_amr;
  }
  return auth;
}

/** Mints a try token for the caller's sandbox key, bound to this session. */
export async function mintTryToken(ctx: ServiceContext, session: SessionAuth): Promise<TryToken> {
  await enforceRateLimit(ctx.env, 'RL_API_TRY', tryBucket(session.sessionId));
  const now = ctx.clock.now();
  const found = await tryKeyOf(ctx.env.DB, session.userId, now);
  if (!found) throw new NotFoundError('Sandbox not found.', 'SANDBOX_NOT_FOUND');
  if (!found.key_id) throw new ConflictError(SANDBOX_KEY_MISSING_COPY, 'SANDBOX_KEY_MISSING');
  const expiresAt = now + TRY_TOKEN_TTL_MS;
  const token = await signTryToken(ctx.env, {
    keyId: found.key_id,
    sessionIdHash: session.sessionId,
    generation: found.try_generation,
    expiresAt,
  });
  ctx.log.info('developer.try_token_minted', { keyId: found.key_id });
  return { token, expiresAt };
}

/** Ends every try token of the caller's open sandbox, without signing out or revoking the key. */
export async function revokeTryTokens(ctx: ServiceContext, session: SessionAuth): Promise<void> {
  const row = await sandboxOfUser(ctx.env.DB, session.userId);
  if (!row || row.closed_at !== null)
    throw new NotFoundError('Sandbox not found.', 'SANDBOX_NOT_FOUND');
  const bumped = await bumpTryGeneration(ctx, row.org_id, {
    userId: session.userId,
    sessionIdHash: session.sessionId,
  });
  if (!bumped)
    throw new ConflictError('The sandbox changed. Reload and retry.', 'SANDBOX_CONFLICT');
}
