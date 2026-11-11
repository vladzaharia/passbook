import type { Mode } from '../../../shared/contracts/common.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type ScanActor, scanScannerCsrfProof, scanSessionCsrfProof } from './actor.ts';
import { sameCsrfProof } from './actor-csrf-proof.ts';
import {
  type ActorCsrfRole,
  actorCsrfAuthorityStmt,
  actorCsrfSnapshotFence,
  capturedCredentialEpoch,
} from './repo-actor-csrf-authority.ts';

export {
  type ActorCsrfRole,
  actorCsrfAuthorityStmt,
  actorCsrfSnapshotFence,
  csrfFenceBelongsTo,
} from './repo-actor-csrf-authority.ts';

/** Raw scalars exist only between a D1 read and its final same-request fence. */
export interface ActorCsrfSnapshot {
  session: {
    id: string;
    userId: string;
    createdAt: number;
    expiresAt: number;
    now: number;
    proof: string;
    secret: string;
  } | null;
  scanner: {
    id: string;
    orgId: string;
    mode: Mode;
    /** The scanner's `credential_epoch` at the read. */
    epoch: number;
    tokenHash: string | null;
    proof: string | null;
    secret: string | null;
  } | null;
}

/** Verify the original proofs before retaining current secrets for the final scalar CAS. */
export async function actorCsrfSnapshotFromResult(
  ctx: ServiceContext,
  actor: ScanActor,
  result: D1Result | undefined,
): Promise<ActorCsrfSnapshot | null> {
  const env = { ...ctx.env };
  const now = ctx.clock.now();
  const principal = actor.principal;
  const identity = { ...actor.actor };
  const orgId = actor.orgId;
  const mode = actor.mode;
  const terminal = actor.terminal;
  const platformSessionId = actor.platformSessionId;
  const authority = actor.tenantAuthority ? { ...actor.tenantAuthority } : undefined;
  const scanner = actor.scanner && {
    id: actor.scanner.id,
    orgId: actor.scanner.orgId,
    mode: actor.scanner.mode,
    tokenHash: actor.scanner.tokenHash,
  };
  const scannerProof = actor.scannerCsrfProof;
  if (scanner && (scanner.orgId !== orgId || scanner.mode !== mode)) return null;
  const row = result?.results?.[0] as
    | {
        session_id?: unknown;
        session_user?: unknown;
        session_secret?: unknown;
        session_idle?: unknown;
        scanner_id?: unknown;
        scanner_org?: unknown;
        scanner_mode?: unknown;
        scanner_epoch?: unknown;
        scanner_token?: unknown;
        scanner_secret?: unknown;
      }
    | undefined;
  if (!row) return null;
  let session: ActorCsrfSnapshot['session'] = null;
  if (principal === 'admin') {
    if (
      !authority ||
      authority.sessionId !== platformSessionId ||
      identity.type !== 'user' ||
      authority.userId !== identity.id ||
      row.session_id !== authority.sessionId ||
      row.session_user !== authority.userId ||
      typeof authority.sessionCsrfProof !== 'string' ||
      !Number.isSafeInteger(authority.sessionCreatedAt) ||
      !Number.isSafeInteger(authority.sessionExpiresAt) ||
      authority.sessionExpiresAt <= authority.sessionCreatedAt ||
      authority.sessionExpiresAt <= now ||
      typeof row.session_idle !== 'number' ||
      row.session_idle <= now ||
      typeof row.session_secret !== 'string' ||
      !row.session_secret
    )
      return null;
    const actual = await scanSessionCsrfProof(env, authority.sessionId, row.session_secret);
    if (!sameCsrfProof(actual, authority.sessionCsrfProof)) return null;
    session = {
      id: authority.sessionId,
      userId: authority.userId,
      createdAt: authority.sessionCreatedAt,
      expiresAt: authority.sessionExpiresAt,
      now,
      proof: authority.sessionCsrfProof,
      secret: row.session_secret,
    };
  } else if (row.session_id !== undefined) return null;
  let scannerSnapshot: ActorCsrfSnapshot['scanner'] = null;
  if (scanner) {
    if (
      row.scanner_id !== scanner.id ||
      row.scanner_org !== orgId ||
      row.scanner_mode !== mode ||
      typeof row.scanner_epoch !== 'number' ||
      row.scanner_epoch !== capturedCredentialEpoch(actor, row.scanner_epoch) ||
      row.scanner_token !== scanner.tokenHash
    )
      return null;
    const epoch = row.scanner_epoch;
    if (row.scanner_secret === null) {
      if (scannerProof !== null || (principal === 'scanner' && !terminal)) return null;
      scannerSnapshot = {
        id: scanner.id,
        orgId,
        mode,
        epoch,
        tokenHash: scanner.tokenHash,
        proof: null,
        secret: null,
      };
    } else {
      if (
        terminal ||
        typeof row.scanner_secret !== 'string' ||
        !row.scanner_secret ||
        typeof scannerProof !== 'string'
      )
        return null;
      const actual = await scanScannerCsrfProof(env, scanner.id, row.scanner_secret);
      if (!sameCsrfProof(actual, scannerProof)) return null;
      scannerSnapshot = {
        id: scanner.id,
        orgId,
        mode,
        epoch,
        tokenHash: scanner.tokenHash,
        proof: scannerProof,
        secret: row.scanner_secret,
      };
    }
  } else if (principal === 'scanner' || row.scanner_id !== undefined) return null;
  if (session) {
    const finalNow = ctx.clock.now();
    if (
      session.expiresAt <= finalNow ||
      typeof row.session_idle !== 'number' ||
      row.session_idle <= finalNow
    )
      return null;
    session.now = finalNow;
  }
  return { session, scanner: scannerSnapshot };
}

export async function actorCsrfAuthorityFromResult(
  ctx: ServiceContext,
  actor: ScanActor,
  result: D1Result | undefined,
): Promise<boolean> {
  const snapshot = await actorCsrfSnapshotFromResult(ctx, actor, result);
  return snapshot !== null && actorCsrfSnapshotFence(actor, snapshot) !== null;
}

export async function actorCsrfFenceFromResult(
  ctx: ServiceContext,
  actor: ScanActor,
  result: D1Result | undefined,
  role: ActorCsrfRole = 'actor',
): Promise<{ sql: string; params: readonly SqlValue[] } | null> {
  const snapshot = await actorCsrfSnapshotFromResult(ctx, actor, result);
  return snapshot ? actorCsrfSnapshotFence(actor, snapshot, role) : null;
}

export async function actorCsrfFence(
  ctx: ServiceContext,
  actor: ScanActor,
  role: ActorCsrfRole = 'actor',
): Promise<{ sql: string; params: readonly SqlValue[] } | null> {
  const observed = { ...ctx, env: { ...ctx.env } };
  const query = actorCsrfAuthorityStmt(observed.env.DB, actor);
  return actorCsrfFenceFromResult(observed, actor, query ? await query.all() : undefined, role);
}

export async function actorCsrfAuthorityCurrent(
  ctx: ServiceContext,
  actor: ScanActor,
): Promise<boolean> {
  const observed = { ...ctx, env: { ...ctx.env } };
  const query = actorCsrfAuthorityStmt(observed.env.DB, actor);
  return actorCsrfAuthorityFromResult(observed, actor, query ? await query.all() : undefined);
}
