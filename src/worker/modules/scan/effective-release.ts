import { ownReleaseSaysSameSql, usedReleaseIdSql } from './repo-pass-release-sql.ts';

/** `[id, generation, version, candidateHash]` of the release a pass is used under. */
export type EffectiveRelease = [string, number, string, string];

/**
 * SQL for the id of the release a scan read uses for `pass` (a trusted alias of the passes row):
 * the effective head, except that a head which only republishes the pass's own release
 * (`ownReleaseSaysSameSql`) leaves the pass's own. A pass without a head keeps its own. One scalar
 * subquery, no binds.
 */
export function effectiveReleaseIdSql(pass: string): string {
  return `(SELECT CASE WHEN ${ownReleaseSaysSameSql(pass, 'er_head')} THEN ${pass}.release_id
    ELSE er_head.id END FROM template_releases er_head WHERE er_head.id = (${usedReleaseIdSql(pass)}))`;
}

/** The fence for a read that must refuse when the pass's effective release moved: one bind, the release id read earlier (null: none). */
export const effectiveReleaseIs = (pass: string): string => `${effectiveReleaseIdSql(pass)} IS ?`;

/**
 * The effective release a template snapshot captured (JSON with a `release` member), as
 * `effectiveReleaseIdSql` would answer now: `null` for a pass without a release, `false` when the
 * snapshot is missing or malformed.
 */
export function usedRelease(raw: string | undefined | null): EffectiveRelease | null | false {
  if (!raw) return false;
  let release: unknown;
  try {
    release = (JSON.parse(raw) as { release?: unknown }).release;
  } catch {
    return false;
  }
  if (release === null) return null;
  const r = release as Record<string, unknown> | undefined;
  return r &&
    typeof r.id === 'string' &&
    typeof r.generation === 'number' &&
    typeof r.version === 'string' &&
    typeof r.candidateHash === 'string'
    ? [r.id, r.generation, r.version, r.candidateHash]
    : false;
}
