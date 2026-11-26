import { TRY_TOKEN_PREFIX } from '../../platform/browser-signals.ts';
import { derivedHmacKey, macPreviousVersion } from '../../platform/crypto.ts';
import { fromBase64Url, safeEqual, toBase64Url } from '../../platform/ids.ts';

/** How long a Workbench token lives; the client renews it at 12 minutes while the tab is visible. */
export const WORKBENCH_TOKEN_TTL_MS = 15 * 60_000;
// The try token's rotatable MAC root; the `workbench|` message prefix keeps v2 apart from v1's `developer-try|`.
const LABEL = 'developer-try.v1';
const MAX_LENGTH = 512;
const SESSION_ID_HASH = /^[0-9a-f]{64}$/;
const ID = /^[0-9A-Za-z_-]{1,64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * What a Workbench token is bound to. `ref` is the sandbox key (`sandbox_key`) or the membership (`member`);
 * `generation` is the sandbox's try generation or the session's member epoch.
 */
export interface WorkbenchClaims {
  subject: 'sandbox_key' | 'member';
  orgId: string;
  ref: string;
  sessionIdHash: string;
  generation: number;
  expiresAt: number;
}

const SUBJECT_CODE = { sandbox_key: 's', member: 'm' } as const;

/** `RL_API_TRY` counts per session, the token's binding: minting and every use, before any database read. */
export const tokenBucket = (sessionIdHash: string) => `RL_API_TRY:session:${sessionIdHash}`;

async function mac(env: object, payload: string, version?: number): Promise<string> {
  const key = await derivedHmacKey(env, LABEL, version);
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`workbench|${payload}`) as BufferSource,
  );
  return toBase64Url(new Uint8Array(signed));
}

/**
 * `pbtry_<payload>.<mac>`, the try token's shape: payload `v2:<s|m>:<orgId>:<ref>:<sessionIdHash>:<generation>:<expiresAt>`,
 * base64url. The `/developer/try-token` alias keeps minting `v1`, which `developer/try-token.ts` verifies.
 */
export async function signWorkbenchToken(env: object, claims: WorkbenchClaims): Promise<string> {
  const { subject, orgId, ref, sessionIdHash, generation, expiresAt } = claims;
  const text = `v2:${SUBJECT_CODE[subject]}:${orgId}:${ref}:${sessionIdHash}:${generation}:${expiresAt}`;
  const payload = toBase64Url(encoder.encode(text));
  return `${TRY_TOKEN_PREFIX}${payload}.${await mac(env, payload)}`;
}

/** The claims of a `v2` token this deployment made (under the current MAC root or, mid-rotation, the previous one). */
export async function verifyWorkbenchToken(
  env: object,
  raw: string,
): Promise<WorkbenchClaims | null> {
  if (!raw.startsWith(TRY_TOKEN_PREFIX) || raw.length > MAX_LENGTH) return null;
  const [payload, presented, extra] = raw.slice(TRY_TOKEN_PREFIX.length).split('.');
  if (!payload || !presented || extra !== undefined) return null;
  const previous = macPreviousVersion(env);
  const valid =
    (await safeEqual(await mac(env, payload), presented)) ||
    (previous !== null && (await safeEqual(await mac(env, payload, previous), presented)));
  if (!valid) return null;
  const [version, code, orgId, ref, sessionIdHash, generation, expiresAt, more] = decoder
    .decode(fromBase64Url(payload))
    .split(':');
  const subject = code === 's' ? 'sandbox_key' : code === 'm' ? 'member' : null;
  if (version !== 'v2' || !subject || more !== undefined) return null;
  if (!orgId || !ID.test(orgId) || !ref || !ID.test(ref)) return null;
  if (!sessionIdHash || !SESSION_ID_HASH.test(sessionIdHash)) return null;
  const claims = {
    subject,
    orgId,
    ref,
    sessionIdHash,
    generation: Number(generation),
    expiresAt: Number(expiresAt),
  } as const;
  return Number.isSafeInteger(claims.generation) && Number.isSafeInteger(claims.expiresAt)
    ? claims
    : null;
}
