import { effectiveReleaseIs, usedRelease } from './effective-release.ts';
import type { Candidate } from './repo-lookup.ts';
import { passVisibleSql } from './repo-pass-visible.ts';
import { type ScanReadAuthority, scanRead } from './repo-read-authority.ts';

/**
 * One read for a preview: whether the viewer's authority holds (`actor_ok`) and whether the pass the
 * preview was built from is still live at its generations, under the release it was read with, of
 * the previewed template (`pass_ok`). Null when the candidate carries no usable release snapshot.
 */
export function previewCurrentStmt(
  db: D1Database,
  auth: ScanReadAuthority,
  candidate: Pick<Candidate, 'pass' | 'templateSnapshot'>,
): D1PreparedStatement | null {
  const release = usedRelease(candidate.templateSnapshot?.raw);
  if (release === false) return null;
  const { pass } = candidate;
  return scanRead(
    db,
    auth,
    `SELECT ${auth.ok} AS actor_ok,
      EXISTS (SELECT 1 FROM passes p
        WHERE ${auth.ok} AND p.id = ? AND ${auth.tenant('p', 'passes')} AND p.template_id = ?
          AND ${passVisibleSql('p', { credential: '?', lifecycle: '?' })}
          AND ${effectiveReleaseIs('p')}) AS pass_ok`,
    [
      pass.id,
      pass.templateId,
      pass.credentialGeneration,
      pass.lifecycleGeneration,
      release === null ? null : release[0],
    ],
  );
}

/** The viewer's authority alone: checked before the credential keyset may be created on first use. */
export const previewActorStmt = (db: D1Database, auth: ScanReadAuthority): D1PreparedStatement =>
  scanRead(db, auth, `SELECT ${auth.ok} AS actor_ok`);
