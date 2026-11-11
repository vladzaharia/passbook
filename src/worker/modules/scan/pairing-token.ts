import type { Grant } from '../../platform/authority.ts';
import { epochIs } from '../../platform/authority-checks.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, ValidationError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { deviceLabel } from './dto-console.ts';
import { adminGrant, audited } from './repo-admin-grant.ts';
import type { ConsoleScannerRow } from './repo-scanners.ts';
import {
  addAdminCredential,
  type Credential,
  requirePairingAuthority,
} from './repo-scanners-pair.ts';
import { setupMeta } from './repo-setups.ts';

const DAY = 86_400_000;
export const DEVICE_MAX_MS = 180 * DAY;
export const TERMINAL_TTL_MS = 365 * DAY;

const PAIR_CODES = { config: 'SCANNER_CHANGED', lineage: 'SCANNER_CHANGED' } as const;

export const notPairable = () =>
  new ValidationError('Only browser devices pair with a code.', [], 'SCANNER_NOT_PAIRABLE');

/** A revoked scanner is paired again only when the request says `restore`. True when it restores one. */
export function restoring(scanner: ConsoleScannerRow, restore: boolean): boolean {
  if (scanner.revokedAt === null) return false;
  if (!restore)
    throw new ConflictError(
      'This scanner was removed from use. Restore it to pair it again.',
      'SCANNER_REVOKED',
    );
  return true;
}

export const addRestoreAudit = (
  g: Grant,
  ctx: ServiceContext,
  userId: string,
  scanner: ConsoleScannerRow,
) =>
  g.add(
    audited(g, ctx, {
      orgId: scanner.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scanner.restore',
      targetType: 'scanner',
      targetId: scanner.id,
    }),
  );

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
export async function withCredential<T>(
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
  authority: TenantPassWrite,
  restore = false,
): Promise<Issued> {
  requirePairingAuthority(authority, userId, scanner.orgId);
  if (
    scanner.kind === 'terminal' ||
    (await setupMeta(ctx.env.DB, scanner.orgId, scanner.id))?.admin_session
  )
    throw notPairable();
  const restored = restoring(scanner, restore);
  return withCredential(ctx, 'device', deviceLabel(agent), async (c) => {
    const g = adminGrant(
      ctx,
      'org_mode.scan.pairing.here',
      userId,
      authority,
      scanner.orgId,
      [epochIs('scanners', scanner.id, 'credential_epoch', scanner.credentialEpoch)],
      PAIR_CODES,
      scanner.id,
    );
    addAdminCredential(g, scanner.id, scanner.kind, c);
    g.add(
      audited(g, ctx, {
        orgId: scanner.orgId,
        actorType: 'user',
        actorId: userId,
        action: 'scanner.pair',
        targetType: 'scanner',
        targetId: scanner.id,
        detail: { via: 'console' },
      }),
    );
    if (restored) addRestoreAudit(g, ctx, userId, scanner);
    await g.commit();
    return { token: c.token, csrfSecret: c.csrfSecret, expiresAt: c.expiresAt };
  });
}

/** A terminal's bearer token, shown once. Calling it again replaces the token. */
export async function replaceTerminalToken(
  ctx: ServiceContext,
  userId: string,
  scanner: ConsoleScannerRow,
  authority: TenantPassWrite,
  restore = false,
): Promise<{ token: string; expiresAt: number }> {
  requirePairingAuthority(authority, userId, scanner.orgId);
  if (scanner.kind !== 'terminal')
    throw new ValidationError('Only tills use a token.', [], 'SCANNER_NOT_TERMINAL');
  const restored = restoring(scanner, restore);
  return withCredential(ctx, 'terminal', null, async (c) => {
    const g = adminGrant(
      ctx,
      'org_mode.scan.pairing.token',
      userId,
      authority,
      scanner.orgId,
      [epochIs('scanners', scanner.id, 'credential_epoch', scanner.credentialEpoch)],
      PAIR_CODES,
      scanner.id,
    );
    addAdminCredential(g, scanner.id, scanner.kind, c);
    g.add(
      audited(g, ctx, {
        orgId: scanner.orgId,
        actorType: 'user',
        actorId: userId,
        action: 'scanner.token_replace',
        targetType: 'scanner',
        targetId: scanner.id,
      }),
    );
    if (restored) addRestoreAudit(g, ctx, userId, scanner);
    await g.commit();
    return { token: c.token, expiresAt: c.expiresAt };
  });
}
