import { SCANNER_TOKEN } from '../../platform/auth.ts';
import { bump, read } from '../../platform/counters.ts';
import { batch } from '../../platform/db.ts';
import { AppError, RateLimitedError } from '../../platform/errors.ts';
import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { recordAudit } from '../audit/service.ts';
import { deviceLabel } from './dto-console.ts';
import { type Issued, notPairable, withCredential } from './pairing-token.ts';
import { getScannerByPrefix } from './repo-device.ts';
import type { ConsoleScannerRow } from './repo-scanners.ts';
import {
  clearTokenStmt,
  findByPairCode,
  heldAuditStmt,
  installCredentialStmt,
  setPairCodeStmt,
} from './repo-scanners-pair.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const PAIR_TTL_MS = 10 * MINUTE;
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
