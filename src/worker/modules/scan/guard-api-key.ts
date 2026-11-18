import type { Context } from 'hono';
import type { ScannerAuth } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { reportDenied } from '../../platform/denied.ts';
import {
  type AppError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { apiKeyActs } from './repo-api-key.ts';
import { getScanner, type ScannerRow } from './repo-device.ts';

export const DEVICE_HEADER = 'x-passbook-device';
export const API_KEY_TOKEN = /^wlt_/;

/** A key opens only these calls: read a code, act on it, look a pass up, undo its own scan. */
const KEY_ROUTE = /^(?:\/api\/v1\/scan)?\/(?:resolve|actions|lookup|scans\/[^/]+\/undo)$/;

/** A till's key acting as one named terminal of its own org and mode. */
export interface KeyTerminal {
  keyId: string;
  auth: ScannerAuth;
  row: ScannerRow;
}

/**
 * `Bearer wlt_` plus `x-passbook-device`: the key names the terminal it acts as. Org-bound keys
 * only, listing `scans:write`; the terminal must be in the key's own org and mode (anything else
 * is "not found", so the header cannot probe another tenant), live, and a terminal.
 */
export async function keyTerminalOf(c: Context<AppBindings>, token: string): Promise<KeyTerminal> {
  const key = await c.var.stores.apiKeys.resolve(token);
  if (!key) throw new UnauthenticatedError('The API key is invalid or expired.', 'INVALID_API_KEY');
  if (!key.scopes.includes('scans:write')) {
    reportDenied(c, 'MISSING_SCOPE', key);
    throw new ForbiddenError('The API key lacks the scans:write scope.', 'MISSING_SCOPE');
  }
  if (key.orgId === null) {
    reportDenied(c, 'FORBIDDEN', key);
    throw new ForbiddenError('A platform key cannot scan.', 'API_KEY_ORG_REQUIRED');
  }
  if (c.req.method !== 'POST' || !KEY_ROUTE.test(c.req.path)) {
    reportDenied(c, 'FORBIDDEN', key);
    throw new ForbiddenError('An API key cannot call this route.', 'API_KEY_ROUTE');
  }
  const scannerId = c.req.header(DEVICE_HEADER)?.trim();
  if (!scannerId)
    throw new ValidationError(`Name the terminal in ${DEVICE_HEADER}.`, [], 'DEVICE_REQUIRED');
  const row = await getScanner(c.env.DB, scannerId);
  if (!row || row.orgId !== key.orgId || row.mode !== key.mode || row.revokedAt !== null)
    throw new NotFoundError('Terminal not found.', 'TERMINAL_NOT_FOUND');
  if (row.kind !== 'terminal' || row.deviceRole !== 'scan') {
    reportDenied(c, 'FORBIDDEN', key);
    throw new ForbiddenError('A key acts only as a terminal.', 'TERMINAL_ONLY');
  }
  const auth: ScannerAuth = {
    kind: 'scanner',
    scannerId: row.id,
    orgId: row.orgId,
    mode: row.mode,
    transport: 'bearer',
    csrfSecret: null,
    scannerKind: 'terminal',
    deviceRole: 'scan',
  };
  return { keyId: key.keyId, auth, row };
}

/** A key never approves and never overrides, whatever the terminal's own settings say. */
export function refuseKeyApproval(
  actor: ScanActor,
  req: { approval?: unknown; overrideOf?: unknown },
): void {
  if (actor.apiKeyId && (req.approval !== undefined || req.overrideOf !== undefined))
    throw new ForbiddenError('An API key cannot approve or override.', 'API_KEY_NO_APPROVAL');
}

/** The key lost its authority since the guard read it: revoked, expired, or `scans:write` removed. */
export async function apiKeyRefusal(
  ctx: ServiceContext,
  actor: ScanActor,
): Promise<AppError | null> {
  if (!actor.apiKeyId) return null;
  const acts = await apiKeyActs(
    ctx.env.DB,
    { id: actor.apiKeyId, orgId: actor.orgId, mode: actor.mode },
    ctx.clock.now(),
  );
  return acts
    ? null
    : new UnauthenticatedError('The API key is invalid or expired.', 'INVALID_API_KEY');
}
