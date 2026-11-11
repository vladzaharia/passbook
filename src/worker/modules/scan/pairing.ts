import { SCANNER_TOKEN } from '../../platform/auth.ts';
import { grant } from '../../platform/authority.ts';
import { epochIs } from '../../platform/authority-checks.ts';
import { bump, read } from '../../platform/counters.ts';
import { AppError, RateLimitedError } from '../../platform/errors.ts';
import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { deviceLabel } from './dto-console.ts';
import {
  addRestoreAudit,
  type Issued,
  notPairable,
  restoring,
  withCredential,
} from './pairing-token.ts';
import { adminGrant, audited } from './repo-admin-grant.ts';
import { credentialEpochOf, getScannerByPrefix } from './repo-device.ts';
import type { ConsoleScannerRow } from './repo-scanners.ts';
import {
  addCodeCredential,
  addPairCode,
  addTokenClear,
  findByPairCode,
  requirePairingAuthority,
} from './repo-scanners-pair.ts';
import { setupMeta } from './repo-setups.ts';

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

const PAIRING_CODES = { config: 'SCANNER_CHANGED', lineage: 'SCANNER_CHANGED' } as const;
const REDEEM_CODES = {
  actor: 'PAIRING_INVALID',
  config: 'PAIRING_INVALID',
  lineage: 'PAIRING_INVALID',
} as const;
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
  authority: TenantPassWrite,
  restore = false,
): Promise<Pairing> {
  requirePairingAuthority(authority, userId, scanner.orgId);
  if (
    scanner.kind === 'terminal' ||
    (await setupMeta(ctx.env.DB, scanner.orgId, scanner.id))?.admin_session
  )
    throw notPairable();
  const restored = restoring(scanner, restore);
  const now = ctx.clock.now();
  const code = newPairCode();
  const expiresAt = now + PAIR_TTL_MS;
  const hash = await sha256Hex(code);
  const g = adminGrant(
    ctx,
    'org_mode.scan.pairing.create',
    userId,
    authority,
    scanner.orgId,
    [epochIs('scanners', scanner.id, 'credential_epoch', scanner.credentialEpoch)],
    PAIRING_CODES,
    scanner.id,
  );
  const restart =
    scanner.revokedAt !== null || (scanner.expiresAt !== null && scanner.expiresAt <= now);
  addPairCode(g, scanner.id, hash, expiresAt, userId, now, restart);
  g.add(
    audited(g, ctx, {
      orgId: scanner.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scanner.pairing_create',
      targetType: 'scanner',
      targetId: scanner.id,
      detail: { expiresAt },
    }),
  );
  if (restored) addRestoreAudit(g, ctx, userId, scanner);
  await g.commit();
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
    const g = grant(ctx, {
      purpose: 'org_mode.scan.pairing.redeem',
      // The code names the scanner: it redeems only while the credential is the one the code was
      // issued against (a revoke or an expiry restarts the scanner when the code is issued).
      principal: { kind: 'scanner', scannerId: hit.id, credentialEpoch: hit.credentialEpoch },
      target: hit.id,
      codes: REDEEM_CODES,
    });
    addCodeCredential(g, hit.id, hash, c);
    g.add(
      audited(g, ctx, {
        orgId: hit.orgId,
        actorType: 'scanner',
        actorId: hit.id,
        action: 'scanner.pair',
        targetType: 'scanner',
        targetId: hit.id,
        detail: { via: 'code' },
        ipPrefix: ip,
      }),
    );
    try {
      await g.commit();
    } catch (error) {
      // A concurrent redemption, a revoke or a rotated credential: the code is no longer good.
      if (error instanceof AppError && error.code === 'PAIRING_INVALID') return null;
      throw error;
    }
    return c;
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
  if (!row?.tokenHash || row.kind === 'terminal' || !(await safeEqual(hash, row.tokenHash))) return;
  const g = grant(ctx, {
    purpose: 'org_mode.scan.pairing.unpair',
    principal: { kind: 'scanner', scannerId: row.id, credentialEpoch: credentialEpochOf(row) },
    target: row.id,
  });
  addTokenClear(g, row.id, hash, ctx.clock.now());
  g.add(
    audited(g, ctx, {
      orgId: row.orgId,
      actorType: 'scanner',
      actorId: row.id,
      action: 'scanner.unpair',
      targetType: 'scanner',
      targetId: row.id,
    }),
  );
  try {
    await g.commit();
  } catch (error) {
    // Always safe to call: an expired, revoked or re-paired scanner has nothing left to clear.
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    ctx.log.info('scan.unpair_refused', { scannerId: row.id, code: error.code });
  }
}
