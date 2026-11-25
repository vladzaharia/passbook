import type { Context } from 'hono';
import { SANDBOX_TERMINAL_ALIAS } from '../../../shared/copy/developer.ts';
import { API_KEY_LABEL } from '../../platform/api-key-token.ts';
import { keyCaller, type ScannerAuth } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { noteKeyRefused, reportDenied } from '../../platform/denied.ts';
import {
  type AppError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../../platform/errors.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import { type ServiceContext, serviceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { scannerExpired } from './auth-store.ts';
import {
  apiKeyActs,
  keyBoundTo,
  orgAccessRevisionOf,
  sandboxTerminalIdOf,
} from './repo-api-key.ts';
import { getScanner, type ScannerRow } from './repo-device.ts';
import { ensureSandboxTerminal } from './repo-sandbox-terminal.ts';

export const DEVICE_HEADER = 'x-passbook-device';
export const API_KEY_TOKEN = API_KEY_LABEL;

/** A key opens only these calls: read a code, act on it, undo its own scan, sign a person out. */
const KEY_ROUTE = /^\/api\/v1\/scan\/(?:resolve|actions|sign-out|scans\/[^/]+\/undo)$/;

/** A till's key acting as one named terminal of its own org and mode. */
export interface KeyTerminal {
  keyId: string;
  auth: ScannerAuth;
  row: ScannerRow;
  /** The org's `access_revision` as the key was admitted. */
  orgRevision: number;
  /** A sandbox key (no `scans:write`): it acts only in Test, which the commit checks again. */
  sandbox: boolean;
}

/**
 * `Bearer` key (`pb_`, `pbp_`, `pbo_` or the older `wlt_`) plus `x-passbook-device`: the key names the terminal it acts as. Org-bound keys
 * only, listing `scans:write`; the terminal must be in the key's own org and mode (anything else
 * is "not found", so the header cannot probe another tenant), live, and a terminal.
 */
export async function keyTerminalOf(c: Context<AppBindings>, token: string): Promise<KeyTerminal> {
  const key = await c.var.stores.apiKeys.resolve(token, keyCaller(c));
  if (!key) {
    noteKeyRefused(c, { code: 'INVALID_API_KEY', token });
    throw new UnauthenticatedError('The API key is invalid or expired.', 'INVALID_API_KEY');
  }
  // A sandbox key never holds `scans:write`; it reaches only the sandbox terminal (keyActsAsTerminalSql).
  const sandboxKey =
    key.mode === 'test' &&
    key.orgId !== null &&
    key.orgKind === 'developer' &&
    key.scopes.includes('passes:write');
  if (!key.scopes.includes('scans:write') && !sandboxKey) {
    reportDenied(c, 'MISSING_SCOPE', key);
    noteKeyRefused(c, { code: 'MISSING_SCOPE', keyId: key.keyId, scope: 'scans:write' });
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
  const named = c.req.header(DEVICE_HEADER)?.trim();
  if (!named) {
    reportDenied(c, 'FORBIDDEN', key);
    throw new ValidationError(`Name the terminal in ${DEVICE_HEADER}.`, [], 'DEVICE_REQUIRED');
  }
  const db = c.env.DB;
  let scannerId = named;
  if (sandboxKey && named === SANDBOX_TERMINAL_ALIAS) {
    // A sandbox made before its terminal existed gets it on first use.
    let id = await sandboxTerminalIdOf(db, key.orgId, serviceContext(c).clock.now());
    // The scan rate limits come after this guard, so the write has its own: 30 attempts a minute per key.
    if (id === null) {
      await enforceRateLimit(c.env, 'RL_SCAN_PAIR', `RL_SCAN_PAIR:sandbox-terminal:${key.keyId}`);
      await ensureSandboxTerminal(serviceContext(c), key, key.orgId);
      id = await sandboxTerminalIdOf(db, key.orgId, serviceContext(c).clock.now());
    }
    scannerId = id ?? named;
  }
  const row = await getScanner(db, scannerId);
  // One answer for every way the header can be wrong: unknown, another org or mode, removed, expired
  // or not one of this key's terminals.
  if (
    !row ||
    row.orgId !== key.orgId ||
    row.mode !== key.mode ||
    row.revokedAt !== null ||
    scannerExpired(row, serviceContext(c).clock.now()) ||
    !(await keyBoundTo(db, key.keyId, row.id))
  ) {
    reportDenied(c, 'FORBIDDEN', key);
    throw new NotFoundError('Terminal not found.', 'TERMINAL_NOT_FOUND');
  }
  if (row.kind !== 'terminal' || row.deviceRole !== 'scan') {
    reportDenied(c, 'FORBIDDEN', key);
    throw new ForbiddenError('A key acts only as a terminal.', 'TERMINAL_ONLY');
  }
  const orgRevision = await orgAccessRevisionOf(db, key.orgId);
  if (orgRevision === null) throw new NotFoundError('Terminal not found.', 'TERMINAL_NOT_FOUND');
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
  return { keyId: key.keyId, auth, row, orgRevision, sandbox: !key.scopes.includes('scans:write') };
}

/** The actor a key's call acts as: the key, the org revision it was admitted at, and whether it is a sandbox key. */
export function keyActor(actor: ScanActor, key: KeyTerminal): void {
  actor.apiKeyId = key.keyId;
  actor.apiKeyOrgRevision = key.orgRevision;
  actor.apiKeySandbox = key.sandbox;
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
    {
      id: actor.apiKeyId,
      orgId: actor.orgId,
      mode: actor.mode,
      scannerId: actor.scanner?.id ?? '',
    },
    ctx.clock.now(),
  );
  return acts
    ? null
    : new UnauthenticatedError('The API key is invalid or expired.', 'INVALID_API_KEY');
}
