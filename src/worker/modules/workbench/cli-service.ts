import {
  CLI_CODE_TTL_S,
  CLI_POLL_INTERVAL_S,
  type CliClient,
  type CliToken,
  normalizeCliCode,
} from '../../../shared/contracts/cli.ts';
import {
  CLI_ACCOUNT_MISMATCH_COPY,
  CLI_AUTH_PENDING_COPY,
  CLI_BUSY_COPY,
  CLI_CODE_DENIED_COPY,
  CLI_CODE_EXPIRED_COPY,
  CLI_CODE_NOT_FOUND_COPY,
  CLI_SLOW_DOWN_COPY,
} from '../../../shared/copy/cli.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { baseUrl } from '../../platform/env.ts';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnavailableError,
} from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { deviceCodeHash, newUserCode, tokenTail, userCodeMac } from './cli-codes.ts';
import { chargeLookup, chargeStart, refundLookup } from './cli-limits.ts';
import * as repo from './repo-cli.ts';

const MAX_PENDING = 2_000;

/** What the server saw of a request: the network prefix (audit), the rate prefix, and Cloudflare's country and city. */
export interface CliMeta {
  ipPrefix: string | null;
  ratePrefix: string;
  country: string | null;
  city: string | null;
}

const expired = () => new BadRequestError(CLI_CODE_EXPIRED_COPY, 'CLI_CODE_EXPIRED');
const denied = () => new BadRequestError(CLI_CODE_DENIED_COPY, 'CLI_CODE_DENIED');
const accountMismatch = () => new ConflictError(CLI_ACCOUNT_MISMATCH_COPY, 'CLI_ACCOUNT_MISMATCH');
const pending = () => new BadRequestError(CLI_AUTH_PENDING_COPY, 'CLI_AUTH_PENDING');
const slowDown = () => new BadRequestError(CLI_SLOW_DOWN_COPY, 'CLI_SLOW_DOWN');
const notFound = () => new NotFoundError(CLI_CODE_NOT_FOUND_COPY, 'CLI_CODE_NOT_FOUND');

/** `POST /cli/sessions`: a device code, and the code the person types. */
export async function startCliSession(
  ctx: ServiceContext,
  input: { client: CliClient; accountHint?: string | undefined },
  meta: CliMeta,
) {
  const now = ctx.clock.now();
  await chargeStart(ctx, meta.ratePrefix);
  await repo.purgeCliSessions(ctx.env.DB, now);
  if ((await repo.countPending(ctx.env.DB, now)) >= MAX_PENDING)
    throw new UnavailableError(CLI_BUSY_COPY, 'CLI_BUSY');
  const deviceCode = ctx.ids.token(32);
  const id = ctx.ids.id();
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = newUserCode();
    const stored = await repo.insertCliSession(ctx.env.DB, {
      id,
      deviceHash: await deviceCodeHash(deviceCode),
      codeMac: await userCodeMac(ctx.env, userCode),
      client: JSON.stringify(input.client),
      accountHint: input.accountHint ?? null,
      now,
      expiresAt: now + CLI_CODE_TTL_S * 1000,
      ipPrefix: meta.ipPrefix,
      country: meta.country,
      city: meta.city,
    });
    if (!stored) continue;
    ctx.log.info('cli_session.started', {
      code: 'CLI_SESSION_STARTED',
      ipPrefix: meta.ipPrefix,
      cliSessionId: id,
    });
    return {
      deviceCode,
      userCode: `${userCode.slice(0, 4)}-${userCode.slice(4)}`,
      verificationUri: `${baseUrl(ctx.env)}/workbench/cli`,
      expiresIn: CLI_CODE_TTL_S,
      interval: CLI_POLL_INTERVAL_S,
    };
  }
  throw new UnavailableError(CLI_BUSY_COPY, 'CLI_BUSY');
}

/** The approving network differs from the starting one (prefix or country). */
const differs = (row: repo.CliSessionRow, meta: CliMeta) =>
  row.ip_prefix !== meta.ipPrefix || (row.country ?? null) !== (meta.country ?? null);

/**
 * `POST /cli/sessions/lookup`: what the typed code is. A miss, an expired code and a used one answer alike;
 * misses are counted per account and per network prefix, and past the limit the field locks (429).
 */
export async function lookupCliCode(
  ctx: ServiceContext,
  session: SessionAuth,
  userCode: string,
  meta: CliMeta,
) {
  await chargeLookup(ctx, session.userId, meta.ratePrefix);
  const code = normalizeCliCode(userCode);
  const row = code
    ? await repo.pendingByCode(ctx.env.DB, await userCodeMac(ctx.env, code), ctx.clock.now())
    : null;
  if (!row) {
    ctx.log.info('cli_session.code_miss', { code: 'CLI_CODE_MISS', ipPrefix: meta.ipPrefix });
    throw notFound();
  }
  await refundLookup(ctx, session.userId, meta.ratePrefix);
  const user = await repo.userOf(ctx.env.DB, session.userId);
  return {
    id: row.id,
    client: JSON.parse(row.client) as CliClient,
    startedAt: row.created_at,
    startCountry: row.country,
    startCity: row.city,
    mismatch: differs(row, meta),
    account: {
      id: session.userId,
      name: user?.name ?? user?.primary_email ?? '',
      email: user?.primary_email ?? '',
    },
    accountMismatch: row.account_hint !== null && row.account_hint !== session.userId,
  };
}

/** `POST /cli/sessions/{id}/deny`. Once: a second answer finds nothing. */
export async function denyCliSession(
  ctx: ServiceContext,
  session: SessionAuth,
  id: string,
  meta: CliMeta,
): Promise<void> {
  const now = ctx.clock.now();
  if (!(await repo.settleCliSession(ctx.env.DB, id, now, { state: 'denied' }))) throw notFound();
  await recordAudit(ctx, {
    orgId: null,
    actorType: 'user',
    actorId: session.userId,
    action: 'cli_session.denied',
    targetType: 'cli_session',
    targetId: id,
    ipPrefix: meta.ipPrefix,
  });
}

/**
 * `POST /cli/sessions/token`: pending, too fast, denied, gone, or the token, once. The device code is the only
 * credential, so an unknown one answers like an expired one.
 */
export async function pollCliSession(ctx: ServiceContext, deviceCode: string): Promise<CliToken> {
  const now = ctx.clock.now();
  const row = await repo.byDeviceHash(ctx.env.DB, await deviceCodeHash(deviceCode));
  if (!row || row.consumed_at !== null || row.token_revoked_at !== null) throw expired();
  if (row.state === 'denied') throw denied();
  if (row.state === 'pending' || row.token_id === null) {
    if (row.expires_at <= now) throw expired();
    // An account other than the one the CLI asked for tried to approve: the CLI is told, once it polls.
    if (row.mismatch_at !== null) throw accountMismatch();
    const tooFast = row.last_poll_at !== null && now - row.last_poll_at < row.interval_s * 1000;
    await repo.notePoll(ctx.env.DB, row.id, now, tooFast);
    throw tooFast ? slowDown() : pending();
  }
  // The one poll that sets `consumed_at` hands the token over; a racing poll finds it gone.
  const won = await repo.consumeCliSession(ctx.env.DB, row.id, now);
  if (!won) throw expired();
  const [key, org, user] = await Promise.all([
    repo.keySecretParts(ctx.env.DB, won.token_id),
    repo.orgOf(ctx.env.DB, won.org_id),
    repo.userOf(ctx.env.DB, won.user_id),
  ]);
  if (!key || !org || !user) throw expired();
  const token = `pbcli_test_${key.prefix}_${await tokenTail(ctx.env, row.id, key.prefix)}`;
  // The derived secret must be the stored key's: a mismatch (a rotated server key) hands over nothing.
  if ((await sha256Hex(token)) !== key.key_hash) {
    ctx.log.error('cli_token.derive_mismatch', { code: 'CLI_TOKEN_DERIVE', cliSessionId: row.id });
    throw expired();
  }
  return {
    token,
    tokenId: won.token_id,
    orgId: won.org_id,
    context: { kind: org.kind === 'developer' ? 'sandbox' : 'org', name: org.name },
    account: { id: user.id, name: user.name ?? user.primary_email, email: user.primary_email },
    expiresAt: key.expires_at ?? now,
    origin: new URL(baseUrl(ctx.env)).origin,
  };
}
