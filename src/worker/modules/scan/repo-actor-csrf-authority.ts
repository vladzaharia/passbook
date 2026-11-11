import { type SqlValue, stmt } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import type { ActorCsrfSnapshot } from './actor-csrf.ts';
import { sameCsrfProof } from './actor-csrf-proof.ts';
import { scanEpochsOf } from './scan-epochs.ts';

/** The credential epoch the guard captured with the token, or the one just read for an uncaptured actor. */
export const capturedCredentialEpoch = (actor: ScanActor, read: number): number =>
  scanEpochsOf(actor)?.scanner?.credential ?? read;

/*
 * The scanner's credential is compared by its `credential_epoch` (authority-epochs.md F5). Token
 * hash and CSRF secret are credential columns, so an epoch bump covers them; `updated_at` is a
 * timestamp and is never compared.
 */

/** Batch this current-secret read with other actor and pass authority reads. */
export function actorCsrfAuthorityStmt(
  db: D1Database,
  actor: ScanActor,
): D1PreparedStatement | null {
  const scanner = actor.scanner;
  if (actor.principal === 'admin') {
    const authority = actor.tenantAuthority;
    if (
      !authority ||
      authority.sessionId !== actor.platformSessionId ||
      authority.userId !== actor.actor.id ||
      actor.actor.type !== 'user'
    )
      return null;
    if (scanner) {
      return stmt(
        db,
        `SELECT session.id_hash AS session_id, session.user_id AS session_user,
          session.csrf_secret AS session_secret, session.idle_expires_at AS session_idle,
          device.id AS scanner_id, device.org_id AS scanner_org, device.mode AS scanner_mode,
          device.credential_epoch AS scanner_epoch, device.token_hash AS scanner_token,
          device.csrf_secret AS scanner_secret
        FROM sessions session JOIN users u ON u.id=session.user_id AND u.status='active'
        JOIN scanners device ON device.id=?/* scan-ephemeral-scanner-id */ AND device.org_id=? AND device.mode=?
          AND device.token_hash IS ?/* scan-ephemeral-scanner-token-hash */ AND device.revoked_at IS NULL
        WHERE session.id_hash=?/* scan-ephemeral-session-id-hash */ AND session.user_id=? AND session.created_at=? AND session.expires_at=?
          AND session.revoked_at IS NULL`,
        [
          scanner.id,
          actor.orgId,
          actor.mode,
          scanner.tokenHash,
          authority.sessionId,
          authority.userId,
          authority.sessionCreatedAt,
          authority.sessionExpiresAt,
        ],
      );
    }
    return stmt(
      db,
      `SELECT session.id_hash AS session_id, session.user_id AS session_user,
        session.csrf_secret AS session_secret, session.idle_expires_at AS session_idle
      FROM sessions session JOIN users u ON u.id=session.user_id AND u.status='active'
      WHERE session.id_hash=?/* scan-ephemeral-session-id-hash */ AND session.user_id=? AND session.created_at=? AND session.expires_at=?
        AND session.revoked_at IS NULL`,
      [
        authority.sessionId,
        authority.userId,
        authority.sessionCreatedAt,
        authority.sessionExpiresAt,
      ],
    );
  }
  if (
    !scanner ||
    actor.actor.type !== 'scanner' ||
    actor.actor.id !== scanner.id ||
    actor.terminal !== (scanner.kind === 'terminal') ||
    !scanner.tokenHash
  )
    return null;
  return stmt(
    db,
    `SELECT id AS scanner_id, org_id AS scanner_org, mode AS scanner_mode,
    credential_epoch AS scanner_epoch, token_hash AS scanner_token, csrf_secret AS scanner_secret
    FROM scanners WHERE id=?/* scan-ephemeral-scanner-id */ AND org_id=? AND mode=?
    AND token_hash IS ?/* scan-ephemeral-scanner-token-hash */ AND revoked_at IS NULL`,
    [scanner.id, actor.orgId, actor.mode, scanner.tokenHash],
  );
}

export type ActorCsrfRole = 'actor' | 'source' | 'recipient';

/** Keep the secrets outside packed JSON in the final same-batch authority fence. */
export function actorCsrfSnapshotFence(
  actor: ScanActor,
  snapshot: ActorCsrfSnapshot,
  role: ActorCsrfRole = 'actor',
): { sql: string; params: SqlValue[] } | null {
  if (role !== 'actor' && role !== 'source' && role !== 'recipient') return null;
  const authority = actor.tenantAuthority;
  if (actor.principal === 'admin') {
    const session = snapshot.session;
    if (
      !session ||
      !authority ||
      actor.actor.type !== 'user' ||
      authority.orgId !== actor.orgId ||
      authority.mode !== actor.mode ||
      authority.userId !== actor.actor.id ||
      authority.userId !== session.userId ||
      authority.sessionId !== actor.platformSessionId ||
      authority.sessionId !== session.id ||
      authority.sessionCreatedAt !== session.createdAt ||
      authority.sessionExpiresAt !== session.expiresAt ||
      !sameCsrfProof(session.proof, authority.sessionCsrfProof)
    )
      return null;
  } else if (
    snapshot.session !== null ||
    !actor.scanner ||
    actor.actor.type !== 'scanner' ||
    actor.actor.id !== actor.scanner.id ||
    actor.terminal !== (actor.scanner.kind === 'terminal')
  ) {
    return null;
  }
  if (!!actor.scanner !== !!snapshot.scanner) return null;
  if (actor.scanner && snapshot.scanner) {
    const scanner = snapshot.scanner;
    if (
      scanner.id !== actor.scanner.id ||
      scanner.orgId !== actor.orgId ||
      scanner.orgId !== actor.scanner.orgId ||
      scanner.mode !== actor.mode ||
      scanner.mode !== actor.scanner.mode ||
      scanner.epoch !== capturedCredentialEpoch(actor, scanner.epoch) ||
      scanner.tokenHash !== actor.scanner.tokenHash ||
      (scanner.proof === null
        ? actor.scannerCsrfProof !== null ||
          scanner.secret !== null ||
          (actor.principal === 'scanner' && !actor.terminal)
        : typeof actor.scannerCsrfProof !== 'string' ||
          scanner.secret === null ||
          !sameCsrfProof(scanner.proof, actor.scannerCsrfProof))
    )
      return null;
  }
  const parts: string[] = [];
  const params: SqlValue[] = [];
  if (snapshot.session) {
    const session = snapshot.session;
    parts.push(`EXISTS (SELECT 1 FROM sessions csrf_${role}_session
      JOIN users csrf_${role}_user ON csrf_${role}_user.id=csrf_${role}_session.user_id
      WHERE csrf_${role}_session.id_hash=?/* scan-ephemeral-session-id-hash */ AND csrf_${role}_session.user_id=?
        AND csrf_${role}_session.created_at=? AND csrf_${role}_session.expires_at=?
        AND csrf_${role}_session.revoked_at IS NULL AND csrf_${role}_user.status='active'
        AND csrf_${role}_session.expires_at>? AND csrf_${role}_session.idle_expires_at>?
        AND csrf_${role}_session.csrf_secret=?/* scan-ephemeral-csrf:${role}:session */)`);
    params.push(
      session.id,
      session.userId,
      session.createdAt,
      session.expiresAt,
      session.now,
      session.now,
      session.secret,
    );
  }
  if (snapshot.scanner) {
    const scanner = snapshot.scanner;
    parts.push(`EXISTS (SELECT 1 FROM scanners csrf_${role}_scanner
      WHERE csrf_${role}_scanner.id=?/* scan-ephemeral-scanner-id */ AND csrf_${role}_scanner.org_id=? AND csrf_${role}_scanner.mode=?
        AND csrf_${role}_scanner.credential_epoch=? AND csrf_${role}_scanner.token_hash IS ?/* scan-ephemeral-scanner-token-hash */
        AND csrf_${role}_scanner.revoked_at IS NULL AND ${
          scanner.secret === null
            ? `csrf_${role}_scanner.csrf_secret IS NULL`
            : `csrf_${role}_scanner.csrf_secret=?/* scan-ephemeral-csrf:${role}:scanner */`
        })`);
    params.push(scanner.id, scanner.orgId, scanner.mode, scanner.epoch, scanner.tokenHash);
    if (scanner.secret !== null) params.push(scanner.secret);
  }
  const fence = { sql: parts.join(' AND ') || '1', params };
  csrfFenceOwners.set(fence, ownerOf(actor));
  return fence;
}

interface FenceOwner {
  actorKey: string;
  orgId: string;
  mode: string;
  scannerId: string | null;
  sessionId: string | null;
}

const csrfFenceOwners = new WeakMap<object, FenceOwner>();

const ownerOf = (actor: ScanActor): FenceOwner => ({
  actorKey: actor.actorKey,
  orgId: actor.orgId,
  mode: actor.mode,
  scannerId: actor.scanner?.id ?? null,
  sessionId: actor.principal === 'admin' ? (actor.platformSessionId ?? null) : null,
});

/** True when this fence was built by `actorCsrfSnapshotFence` for this actor (provenance, not layout). */
export function csrfFenceBelongsTo(fence: object, actor: ScanActor): boolean {
  const owner = csrfFenceOwners.get(fence);
  const want = ownerOf(actor);
  return (
    !!owner &&
    owner.actorKey === want.actorKey &&
    owner.orgId === want.orgId &&
    owner.mode === want.mode &&
    owner.scannerId === want.scannerId &&
    owner.sessionId === want.sessionId
  );
}
