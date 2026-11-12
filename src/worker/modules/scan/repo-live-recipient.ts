import type { SqlValue } from '../../platform/db.ts';
import { stmt } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import type { ScanActor } from './actor.ts';
import {
  type SessionLegacyStamp,
  type SessionReleaseStamp,
  sessionTemplateStampsPredicate,
} from './repo-scope-releases.ts';
import { sessionReadAuthorityPredicate } from './repo-session-authority.ts';
import { observedScanningSession } from './scanning-workspace-observation.ts';

/** Select the watch in the same batch as the recipient's template stamps. */
export function liveRecipientWatchStmt(
  db: D1Database,
  actor: ScanActor,
  scanner: NonNullable<ScanActor['scanner']>,
): D1PreparedStatement {
  const sessionId =
    actor.scanningSession && actor.scanningSession.id !== scanner.id
      ? actor.scanningSession.id
      : null;
  return stmt(
    db,
    `SELECT m.watch,
      (SELECT json_group_array(id) FROM (
        SELECT s.id FROM scanning_devices d
        JOIN scanning_sessions p ON p.id=d.session_id AND p.org_id=d.org_id AND p.mode=d.mode
        JOIN scanners s ON s.id=d.scanner_id AND s.org_id=d.org_id AND s.mode=d.mode
        WHERE d.org_id=? AND d.mode=? AND d.session_id=?
          AND s.device_role='scan' AND s.revoked_at IS NULL ORDER BY s.id
      )) AS session_watch
      FROM scanners screen LEFT JOIN scanner_setups m
        ON m.scanner_id=screen.id AND m.org_id=screen.org_id AND m.mode=screen.mode
      WHERE screen.id=? AND screen.org_id=? AND screen.mode=?`,
    [actor.orgId, actor.mode, sessionId, scanner.id, actor.orgId, actor.mode],
  );
}

/** The exact watch used to select live rows for this recipient. */
export type LiveWatchStamp =
  | { kind: 'standalone'; raw: string }
  | { kind: 'session'; sessionId: string; scannerIds: readonly string[] };

/** Independently bindable recipient fences, evaluated together in one D1 snapshot. */
export function liveRecipientFenceParts(
  actor: ScanActor,
  now: number,
  releases: readonly SessionReleaseStamp[],
  legacy: readonly SessionLegacyStamp[],
  watch: LiveWatchStamp,
): { sql: string; params: SqlValue[] }[] {
  const denied = () => [{ sql: '0', params: [] }];
  if (
    !actor.scanner ||
    actor.invalidScannerScope ||
    !actor.credentialKeysetCommitment ||
    !/^[a-f0-9]{64}$/.test(actor.credentialKeysetCommitment)
  )
    return denied();
  const ids = new Set([
    ...releases.map((stamp) => stamp.templateId),
    ...legacy.map((stamp) => stamp.templateId),
  ]);
  if (
    ids.size !== releases.length + legacy.length ||
    ids.size !== actor.templateIds.length ||
    actor.templateIds.some((id) => !ids.has(id))
  )
    return denied();

  let watchSql: string;
  let watchParams: SqlValue[];
  if (watch.kind === 'standalone') {
    if (actor.scanningSession && actor.scanningSession.id !== actor.scanner.id) return denied();
    watchSql = `EXISTS (SELECT 1 FROM scanner_setups m
      WHERE m.scanner_id=?/* scan-ephemeral-scanner-id */ AND m.org_id=? AND m.mode=?
        AND m.watch IS ?/* scan-ephemeral-event-scope */)`;
    watchParams = [actor.scanner.id, actor.orgId, actor.mode, watch.raw];
  } else {
    if (
      !actor.scanningSession ||
      actor.scanningSession.id !== watch.sessionId ||
      actor.scanningSession.id === actor.scanner.id ||
      new Set(watch.scannerIds).size !== watch.scannerIds.length
    )
      return denied();
    const seen = JSON.stringify(watch.scannerIds);
    watchSql = `(
      (SELECT COUNT(*) FROM scanning_devices d
       JOIN scanning_sessions p ON p.id=d.session_id AND p.org_id=d.org_id AND p.mode=d.mode
       JOIN scanners s ON s.id=d.scanner_id AND s.org_id=d.org_id AND s.mode=d.mode
       WHERE d.org_id=? AND d.session_id=?/* scan-ephemeral-session-id */ AND d.mode=?
         AND s.device_role='scan' AND s.revoked_at IS NULL)
        = json_array_length(?/* scan-ephemeral-event-scope */)
      AND NOT EXISTS (
        SELECT 1 FROM scanning_devices d
        JOIN scanning_sessions p ON p.id=d.session_id AND p.org_id=d.org_id AND p.mode=d.mode
        JOIN scanners s ON s.id=d.scanner_id AND s.org_id=d.org_id AND s.mode=d.mode
        WHERE d.org_id=? AND d.session_id=?/* scan-ephemeral-session-id */ AND d.mode=?
          AND s.device_role='scan' AND s.revoked_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM json_each(?/* scan-ephemeral-event-scope */) j WHERE j.type='text' AND j.value=s.id)
      )
    )`;
    watchParams = [
      actor.orgId,
      watch.sessionId,
      actor.mode,
      seen,
      actor.orgId,
      watch.sessionId,
      actor.mode,
      seen,
    ];
  }

  const authority = sessionReadAuthorityPredicate(actor, now);
  const stamps = sessionTemplateStampsPredicate(releases, legacy, 'scope.org_id', 'scope.mode');
  const scope = observedScanningSession(actor)?.scope;
  const additional =
    scope?.stamps.map((stamp) =>
      sessionTemplateStampsPredicate(stamp.releases, stamp.legacy, 'scope.org_id', 'scope.mode'),
    ) ?? [];
  return [
    authority,
    stamps,
    ...additional,
    { sql: watchSql, params: watchParams },
    { sql: credentialRefKeysetSql, params: [actor.credentialKeysetCommitment] },
  ];
}
