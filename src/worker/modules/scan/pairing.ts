import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { SCANNER_TOKEN } from '../../platform/auth.ts';
import { bump, read } from '../../platform/counters.ts';
import { batch, classifyD1Error } from '../../platform/db.ts';
import { AppError, RateLimitedError, ValidationError } from '../../platform/errors.ts';
import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { recordAudit } from '../audit/service.ts';
import { getOrgRow } from '../orgs/repo.ts';
import { deviceLabel, parseSettings } from './dto-console.ts';
import { getScanner, getScannerByPrefix } from './repo-device.ts';
import {
  type ConsoleScannerRow,
  type Credential,
  clearTokenStmt,
  findByPairCode,
  heldAuditStmt,
  installCredentialStmt,
  setPairCodeStmt,
} from './repo-scanners.ts';
import { readScannerScope } from './repo-scope.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 86_400_000;
export const PAIR_TTL_MS = 10 * MINUTE;
export const DEVICE_MAX_MS = 180 * DAY;
export const TERMINAL_TTL_MS = 365 * DAY;
export const PAIR_FAILS_PER_IP = 30;
const PAIR_FLOOD = 500;
const PAIR_FAIL_AUDITS_PER_HOUR = 100;
/** Crockford base32: no I, L, O or U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newPairCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
}

/** Upper-case, drop separators, Crockford I/L to 1 and O to 0. Null when it cannot be a code. */
export function normalizePairCode(raw: string): string | null {
  const code = raw
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  return code.length === 10 && [...code].every((ch) => ALPHABET.includes(ch)) ? code : null;
}

const invalid = () => new AppError('PAIRING_INVALID', 400, 'Code not valid. Ask for a new one.');
const notPairable = () =>
  new ValidationError('Only browser devices pair with a code.', [], 'SCANNER_NOT_PAIRABLE');

export interface Pairing {
  code: string;
  url: string;
  expiresAt: number;
}

/** A fresh code replaces any live one. The code is returned here and nowhere else. */
export async function createPairing(
  ctx: ServiceContext,
  userId: string,
  scanner: ConsoleScannerRow,
  origin: string,
): Promise<Pairing> {
  if (scanner.kind !== 'device') throw notPairable();
  const now = ctx.clock.now();
  const code = newPairCode();
  const expiresAt = now + PAIR_TTL_MS;
  await batch(ctx.env.DB, [
    setPairCodeStmt(ctx.env.DB, scanner.id, await sha256Hex(code), expiresAt, userId, now),
    auditStmt(ctx.env.DB, ctx, {
      orgId: scanner.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scanner.pairing_create',
      targetType: 'scanner',
      targetId: scanner.id,
      detail: { expiresAt },
    }),
  ]);
  return { code, url: `${origin}/scan#pair=${code}`, expiresAt };
}

export interface PairingState {
  state: 'waiting' | 'paired' | 'expired';
  device: { label: string; at: number } | null;
}

export function pairingState(scanner: ConsoleScannerRow, now: number): PairingState {
  if (scanner.hasPairCode)
    return {
      state: (scanner.pairExpiresAt ?? 0) > now ? 'waiting' : 'expired',
      device: null,
    };
  if (scanner.hasToken && scanner.revokedAt === null && scanner.pairedAt !== null)
    return {
      state: 'paired',
      device: { label: scanner.pairedLabel ?? 'Device', at: scanner.pairedAt },
    };
  return { state: 'expired', device: null };
}

function prefixOf(ctx: ServiceContext): string {
  let out = '';
  while (out.length < 8) out += ctx.ids.token(6).replace(/[^A-Za-z0-9]/g, '');
  return out.slice(0, 8);
}

export interface NewCredential extends Credential {
  token: string;
}

/** `wls_<8>_<43>`: the prefix finds the row, the SHA-256 of the whole token is what is stored. */
export async function newCredential(
  ctx: ServiceContext,
  kind: 'device' | 'terminal',
  label: string | null,
): Promise<NewCredential> {
  const now = ctx.clock.now();
  const tokenPrefix = prefixOf(ctx);
  const token = `wls_${tokenPrefix}_${ctx.ids.token(32)}`;
  return {
    token,
    tokenPrefix,
    tokenHash: await sha256Hex(token),
    csrfSecret: kind === 'device' ? ctx.ids.token(32) : null,
    label,
    expiresAt: now + (kind === 'device' ? DEVICE_MAX_MS : TERMINAL_TTL_MS),
    now,
  };
}

/** A prefix collision (2^-47 at 100k scanners) draws again. */
async function withCredential<T>(
  ctx: ServiceContext,
  kind: 'device' | 'terminal',
  label: string | null,
  attempt: (credential: NewCredential) => Promise<T>,
): Promise<T> {
  for (let tries = 0; ; tries++) {
    const credential = await newCredential(ctx, kind, label);
    try {
      return await attempt(credential);
    } catch (error) {
      const info = classifyD1Error(error);
      if (tries < 2 && info?.kind === 'unique' && /token_prefix/.test(info.detail)) continue;
      throw error;
    }
  }
}

export interface Issued {
  token: string;
  csrfSecret: string | null;
  expiresAt: number;
}

/** The admin's own browser becomes the scanner. Replaces the old device's token at once. */
export async function pairHere(
  ctx: ServiceContext,
  userId: string,
  scanner: ConsoleScannerRow,
  agent: string | undefined,
): Promise<Issued> {
  if (scanner.kind !== 'device') throw notPairable();
  return withCredential(ctx, 'device', deviceLabel(agent), async (c) => {
    await batch(ctx.env.DB, [
      installCredentialStmt(ctx.env.DB, scanner.id, c, null),
      auditStmt(ctx.env.DB, ctx, {
        orgId: scanner.orgId,
        actorType: 'user',
        actorId: userId,
        action: 'scanner.pair',
        targetType: 'scanner',
        targetId: scanner.id,
        detail: { via: 'console' },
      }),
    ]);
    return { token: c.token, csrfSecret: c.csrfSecret, expiresAt: c.expiresAt };
  });
}

/** A terminal's bearer token, shown once. Calling it again replaces the token. */
export async function replaceTerminalToken(
  ctx: ServiceContext,
  userId: string,
  scanner: ConsoleScannerRow,
): Promise<{ token: string; expiresAt: number }> {
  if (scanner.kind !== 'terminal')
    throw new ValidationError('Only tills use a token.', [], 'SCANNER_NOT_TERMINAL');
  return withCredential(ctx, 'terminal', null, async (c) => {
    await batch(ctx.env.DB, [
      installCredentialStmt(ctx.env.DB, scanner.id, c, null),
      auditStmt(ctx.env.DB, ctx, {
        orgId: scanner.orgId,
        actorType: 'user',
        actorId: userId,
        action: 'scanner.token_replace',
        targetType: 'scanner',
        targetId: scanner.id,
      }),
    ]);
    return { token: c.token, expiresAt: c.expiresAt };
  });
}

const failKey = (ip: string | null) => `scan:pairfail:${ip ?? 'unknown'}`;
const windowOf = (now: number) => now - (now % HOUR);

async function recordMiss(ctx: ServiceContext, ip: string | null): Promise<void> {
  const db = ctx.env.DB;
  const window = windowOf(ctx.clock.now());
  await bump(db, failKey(ip), window);
  if ((await bump(db, 'scan:pairfail:all', window)) === PAIR_FLOOD + 1)
    ctx.log.error('scan.pair_flood', { code: 'SCAN_PAIR_FLOOD' });
  if ((await bump(db, 'scan:pairfail:audit', window)) <= PAIR_FAIL_AUDITS_PER_HOUR)
    await recordAudit(ctx, {
      actorType: 'system',
      action: 'scanner.pair_failed',
      ipPrefix: ip,
    });
}

/** The scanner a code opens. Unknown, expired and used codes are the same answer. */
async function openCode(ctx: ServiceContext, ip: string | null, raw: string) {
  const now = ctx.clock.now();
  const window = windowOf(now);
  if ((await read(ctx.env.DB, failKey(ip), window)) >= PAIR_FAILS_PER_IP)
    throw new RateLimitedError(Math.ceil((window + HOUR - now) / 1000));
  const code = normalizePairCode(raw);
  const hash = code ? await sha256Hex(code) : null;
  const hit = hash ? await findByPairCode(ctx.env.DB, hash, now) : null;
  if (!hit || !hash) {
    await recordMiss(ctx, ip);
    throw invalid();
  }
  return { hit, hash };
}

/** Consumes nothing: the confirm card shows what the code is for. */
export async function previewPairing(ctx: ServiceContext, ip: string | null, raw: string) {
  const { hit } = await openCode(ctx, ip, raw);
  return { scannerName: hit.name, orgName: hit.orgName, mode: hit.mode };
}

export interface Paired extends Issued {
  scannerId: string;
}

/** The consuming UPDATE and its audit row are one batch; a concurrent loser gets no row and no audit. */
export async function completePairing(
  ctx: ServiceContext,
  ip: string | null,
  agent: string | undefined,
  raw: string,
): Promise<Paired> {
  const { hit, hash } = await openCode(ctx, ip, raw);
  const done = await withCredential(ctx, 'device', deviceLabel(agent), async (c) => {
    const results = await batch(ctx.env.DB, [
      installCredentialStmt(ctx.env.DB, hit.id, c, hash),
      heldAuditStmt(
        ctx.env.DB,
        ctx,
        {
          orgId: hit.orgId,
          actorType: 'scanner',
          actorId: hit.id,
          action: 'scanner.pair',
          targetType: 'scanner',
          targetId: hit.id,
          detail: { via: 'code' },
          ipPrefix: ip,
        },
        c.tokenHash,
      ),
    ]);
    return results[0]?.results.length ? c : null;
  });
  if (!done) {
    await recordMiss(ctx, ip);
    throw invalid();
  }
  return {
    scannerId: hit.id,
    token: done.token,
    csrfSecret: done.csrfSecret,
    expiresAt: done.expiresAt,
  };
}

/** Clears the presented token when it is the scanner's current one. Always safe to call. */
export async function unpair(ctx: ServiceContext, token: string | undefined): Promise<void> {
  if (!token || !SCANNER_TOKEN.test(token)) return;
  const row = await getScannerByPrefix(ctx.env.DB, token.slice(4, 12));
  const hash = await sha256Hex(token);
  if (!row?.tokenHash || row.kind !== 'device' || !(await safeEqual(hash, row.tokenHash))) return;
  await batch(ctx.env.DB, [
    heldAuditStmt(
      ctx.env.DB,
      ctx,
      {
        orgId: row.orgId,
        actorType: 'scanner',
        actorId: row.id,
        action: 'scanner.unpair',
        targetType: 'scanner',
        targetId: row.id,
      },
      hash,
    ),
    clearTokenStmt(ctx.env.DB, row.id, hash, ctx.clock.now()),
  ]);
}

/**
 * What `POST /scan/pair` answers with. The posture only: SV.1's `GET /scan/session` is the full
 * session (templates, formats, counts) and the client reads it right after pairing.
 */
export async function pairedSession(
  ctx: ServiceContext,
  scannerId: string,
  csrfToken: string | null,
): Promise<ScanSession> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const row = await getScanner(db, scannerId);
  if (!row) throw invalid();
  const [scope, org] = await Promise.all([
    readScannerScope(db, row, null),
    getOrgRow(db, row.orgId),
  ]);
  const settings = parseSettings(row.settings);
  const event = scope.event;
  const state: ScanSession['state'] = settings.staffSignIn
    ? 'staff_required'
    : scope.templateIds.length === 0
      ? 'unassigned'
      : event && now < event.opensAt
        ? 'not_open'
        : event && now > event.closesAt
          ? 'closed'
          : 'ready';
  return {
    principal: 'scanner',
    state,
    scanner: {
      id: row.id,
      name: row.name,
      kind: row.kind,
      deviceRole: row.deviceRole,
      mode: row.mode as Mode,
      orgId: row.orgId,
      orgName: org?.name ?? '',
      timeZone: row.timeZone,
      settings,
    },
    admin: null,
    event: event
      ? {
          id: event.id,
          name: event.name,
          opensAt: event.opensAt,
          closesAt: event.closesAt,
          timeZone: event.timeZone,
          reentry: event.reentry,
          note: event.note,
        }
      : null,
    templates: [],
    formats: [],
    staff: null,
    staffList: null,
    approvals: false,
    csrfToken,
    undoWindowMinutes: 10,
    counts: { today: 0, event: null, asOf: now, configRev: row.updatedAt },
  };
}
