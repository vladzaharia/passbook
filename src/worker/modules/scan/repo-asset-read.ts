import { stmt } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { effectiveReleaseIs, usedRelease } from './effective-release.ts';
import { CREDENTIAL_REF_PREFIX } from './repo-credential-tombstones.ts';
import type { Candidate } from './repo-lookup.ts';
import { passVisibleSql } from './repo-pass-visible.ts';
import { type ScanReadAuthority, scanRead } from './repo-read-authority.ts';
import { actorPassScopeSql } from './repo-recipient-scope.ts';

/** Asset choice is read in the same batch as the original candidate. */
export interface ScannerAssetResource {
  branding: string;
  r2_key: string | null;
  sha1: string | null;
}

export function scannerAssetResourceStmt(
  db: D1Database,
  orgId: string,
  passId: string,
  name: string,
): D1PreparedStatement {
  return stmt(
    db,
    `SELECT o.branding, a.r2_key, a.sha1
    FROM passes p JOIN orgs o ON o.id=p.org_id AND o.status='active'
    LEFT JOIN pass_assets a ON a.pass_id=p.id AND a.name=?
    WHERE p.org_id=? AND p.id=?`,
    [name, orgId, passId],
  );
}

export function scannerAssetResourceFromResult(
  result: D1Result | undefined,
): ScannerAssetResource | null {
  return result?.success === true
    ? ((result.results?.[0] as ScannerAssetResource | undefined) ?? null)
    : null;
}

/**
 * The scanner's own image read fence: its authority holds, and the pass is live at the generations
 * the candidate was read at (the image generation too, for a photo), under the release it was used
 * under, inside the actor's scope. One statement; a row only when every part holds.
 */
export async function assetReadCurrent(
  db: D1Database,
  auth: ScanReadAuthority,
  actor: ScanActor,
  candidate: Pick<Candidate, 'pass' | 'templateSnapshot'>,
  photo: boolean,
  /** Leading hex of the refs of the credential the grant was scanned from (none for a pass-id card). */
  refPrefixes: readonly string[] = [],
): Promise<boolean> {
  const scope = actorPassScopeSql(actor, 'p');
  const release = usedRelease(candidate.templateSnapshot?.raw);
  const { pass } = candidate;
  if (!scope || release === false || refPrefixes.length > 3) return false;
  const rest = 64 - CREDENTIAL_REF_PREFIX;
  if (
    !refPrefixes.every((prefix) => new RegExp(`^[0-9a-f]{${CREDENTIAL_REF_PREFIX}}$`).test(prefix))
  )
    return false;
  const row = await scanRead(
    db,
    auth,
    `SELECT 1 AS ok FROM ${auth.rows}passes p
      WHERE ${auth.present} AND p.id = ? AND ${auth.tenantOnce('p', 'passes')}
        AND ${passVisibleSql('p', { credential: '?', lifecycle: '?' })}
        ${photo ? 'AND p.image_generation = ?' : ''}
        AND ${effectiveReleaseIs('p')} AND ${scope.sql}
        ${
          refPrefixes.length
            ? `AND NOT EXISTS (SELECT 1 FROM pass_credential_tombstones tombstone
          WHERE tombstone.org_id = p.org_id AND tombstone.mode = p.mode
            AND (${refPrefixes.map(() => 'tombstone.credential_hash BETWEEN ? AND ?').join(' OR ')}))`
            : ''
        }`,
    [
      pass.id,
      pass.credentialGeneration,
      pass.lifecycleGeneration,
      ...(photo ? [pass.imageGeneration] : []),
      release === null ? null : release[0],
      ...scope.params,
      ...refPrefixes.flatMap((prefix) => [prefix + '0'.repeat(rest), prefix + 'f'.repeat(rest)]),
    ],
  ).first();
  return row !== null;
}
