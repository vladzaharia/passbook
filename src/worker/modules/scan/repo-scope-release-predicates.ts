import type { SqlValue } from '../../platform/db.ts';
import { effectiveReleaseIdSql } from '../templates/repo-release-heads.ts';
import type { ReleaseScopeSql } from '../templates/repo-releases.ts';
import type {
  ScopedReleaseHead,
  SessionLegacyStamp,
  SessionReleaseStamp,
} from './repo-scope-releases.ts';
import { scanConjunction } from './repo-secret-binds.ts';
import { walletIdentityPredicateSql } from './repo-wallet-snapshot.ts';

/** SQL expressions for the captured release a head must still equal. */
export interface ReleaseBindingSql {
  idSql: string;
  generationSql: string;
  versionSql: string;
  candidateHashSql: string;
}

/** The captured release is still the scope's effective head (the bound row, then the head, intersected). */
export function effectiveReleaseBindingPredicate(
  binding: ReleaseBindingSql,
  scope: ReleaseScopeSql,
): string {
  return `EXISTS (
    SELECT bound_release.id FROM template_releases bound_release
    WHERE (bound_release.id = (${binding.idSql}) AND bound_release.generation = (${binding.generationSql})
      AND bound_release.version = (${binding.versionSql})
      AND bound_release.candidate_hash = (${binding.candidateHashSql}))
    INTERSECT ${effectiveReleaseIdSql(scope)}
  )`;
}

/**
 * The captured release row still exists unchanged for this template. Use of a scope never depends on the
 * release staying the head, so a release approved or withdrawn meanwhile does not refuse the request.
 */
function boundReleasePredicate(binding: ReleaseBindingSql, scope: ReleaseScopeSql): string {
  return `EXISTS (
    SELECT 1 FROM template_releases bound_release
    WHERE (bound_release.id = (${binding.idSql}) AND bound_release.generation = (${binding.generationSql})
      AND bound_release.version = (${binding.versionSql})
      AND bound_release.candidate_hash = (${binding.candidateHashSql}))
      AND bound_release.template_id = (${scope.templateIdSql}) AND bound_release.mode = (${scope.modeSql})
      AND bound_release.provider = 'apple'
  )`;
}

/** A legacy pass can use only its own immutable pinned template version. */
export function legacyPassSql(alias: string, scope: ReleaseScopeSql): string {
  return scanConjunction([
    `${alias}.template_id=(${scope.templateIdSql})`,
    `${alias}.org_id=(${scope.orgIdSql})`,
    `${alias}.mode=(${scope.modeSql})`,
    `${alias}.release_id IS NULL`,
    `${alias}.deleted_at IS NULL`,
    `${alias}.test_data_quarantined=0`,
    `EXISTS (SELECT 1 FROM template_versions pinned
      WHERE pinned.template_id=${alias}.template_id AND pinned.version=${alias}.template_version)`,
    walletIdentityPredicateSql({ passAlias: alias }),
  ]);
}

/** A missing or malformed head cannot authorize reuse of an expected-count cache. */
export function releaseHeadsComplete(snapshot: string): boolean {
  let heads: unknown;
  try {
    heads = JSON.parse(snapshot);
  } catch {
    return false;
  }
  if (!Array.isArray(heads) || heads.length === 0 || heads.length > 40) return false;
  const seen = new Set<string>();
  for (const item of heads) {
    const head = item as Partial<ScopedReleaseHead> | null;
    const release = head?.release;
    if (
      !head ||
      typeof head.templateId !== 'string' ||
      !head.templateId ||
      seen.has(head.templateId) ||
      !release ||
      typeof release.id !== 'string' ||
      !release.id ||
      !Number.isSafeInteger(release.generation) ||
      release.generation <= 0 ||
      typeof release.version !== 'string' ||
      !release.version ||
      typeof release.candidateHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(release.candidateHash)
    )
      return false;
    seen.add(head.templateId);
  }
  return true;
}

/** Build the same mixed-head fence for atomic configuration writes and session reads. */
export function sessionTemplateStampsPredicate(
  releases: readonly SessionReleaseStamp[],
  legacy: readonly SessionLegacyStamp[],
  orgIdSql: string,
  modeSql: string,
): { sql: string; params: SqlValue[] } {
  if (!Array.isArray(releases) || !Array.isArray(legacy) || releases.length + legacy.length > 20)
    return { sql: '0', params: [] };
  if (
    releases.length &&
    !releaseHeadsComplete(
      JSON.stringify(
        releases.map((r) => ({
          templateId: r?.templateId,
          release: {
            id: r?.id,
            generation: r?.generation,
            version: r?.version,
            candidateHash: r?.candidateHash,
          },
        })),
      ),
    )
  )
    return { sql: '0', params: [] };
  const seen = new Set(releases.map((release) => release.templateId));
  for (const item of legacy) {
    if (
      !item ||
      typeof item.templateId !== 'string' ||
      !item.templateId ||
      seen.has(item.templateId) ||
      !Array.isArray(item.versions) ||
      item.versions.length === 0 ||
      item.versions.some((version: unknown) => typeof version !== 'string' || !version) ||
      new Set(item.versions).size !== item.versions.length ||
      !Array.isArray(item.identities) ||
      item.identities.length === 0
    )
      return { sql: '0', params: [] };
    const evidence = new Set<string>();
    const versions = new Set<string>();
    for (const identity of item.identities) {
      if (
        !identity ||
        typeof identity.version !== 'string' ||
        !identity.version ||
        typeof identity.identityId !== 'string' ||
        !identity.identityId ||
        !Number.isSafeInteger(identity.identityRevision) ||
        identity.identityRevision <= 0
      )
        return { sql: '0', params: [] };
      const key = JSON.stringify([
        identity.version,
        identity.identityId,
        identity.identityRevision,
      ]);
      if (evidence.has(key)) return { sql: '0', params: [] };
      evidence.add(key);
      versions.add(identity.version);
    }
    if (
      versions.size !== item.versions.length ||
      item.versions.some(
        (version: unknown) => typeof version !== 'string' || !versions.has(version),
      )
    )
      return { sql: '0', params: [] };
    seen.add(item.templateId);
  }
  const scope = { templateIdSql: 't.id', orgIdSql, modeSql, providerSql: "'apple'" };
  const head = boundReleasePredicate(
    {
      idSql: "json_extract(r.value,'$.id')",
      generationSql: "json_extract(r.value,'$.generation')",
      versionSql: "json_extract(r.value,'$.version')",
      candidateHashSql: "json_extract(r.value,'$.candidateHash')",
    },
    scope,
  );
  const legacyEvidence = `SELECT p.template_version,p.identity_id,si.revision FROM passes p
    JOIN signing_identities si ON si.id=p.identity_id WHERE ${legacyPassSql('p', scope)}`;
  const capturedEvidence = `SELECT json_extract(e.value,'$.version'),json_extract(e.value,'$.identityId'),
    json_extract(e.value,'$.identityRevision') FROM json_each(l.value,'$.identities') e`;
  return {
    sql: `NOT EXISTS (SELECT 1 FROM json_each(?) r
      LEFT JOIN templates t ON t.id=json_extract(r.value,'$.templateId')
        AND (t.org_id=${orgIdSql} OR t.org_id IS NULL) AND t.status!='deleted'
      WHERE t.id IS NULL OR COALESCE((${head}),0)!=1)
    AND NOT EXISTS (SELECT 1 FROM json_each(?) l
      LEFT JOIN templates t ON t.id=json_extract(l.value,'$.templateId')
        AND (t.org_id=${orgIdSql} OR t.org_id IS NULL) AND t.status!='deleted'
      WHERE t.id IS NULL
        OR EXISTS (${legacyEvidence} EXCEPT ${capturedEvidence})
        OR EXISTS (${capturedEvidence} EXCEPT ${legacyEvidence}))`,
    params: [JSON.stringify(releases), JSON.stringify(legacy)],
  };
}
