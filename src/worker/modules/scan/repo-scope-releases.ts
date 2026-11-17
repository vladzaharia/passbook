import type { Mode } from '../../../shared/contracts/common.ts';
import { stmt } from '../../platform/db.ts';
import { effectiveReleaseIdSql } from '../templates/repo-release-heads.ts';
import type { ReleaseScopeSql } from '../templates/repo-releases.ts';
import { walletIdentityPredicateSql } from './repo-wallet-snapshot.ts';
import { scanConjunction } from './scan-conjunction.ts';

/** Configured scopes remain restricted, including when they contain only eligible legacy passes. */
export function usableScanTemplateSql(scope: ReleaseScopeSql): string {
  return `((${scope.providerSql})='apple' AND EXISTS (SELECT 1 FROM templates use_template
      WHERE use_template.id=(${scope.templateIdSql}) AND use_template.status!='deleted'
        AND (use_template.org_id IS NULL OR use_template.org_id=(${scope.orgIdSql})))
    AND (EXISTS (SELECT 1 FROM template_releases use_release
      WHERE use_release.template_id=(${scope.templateIdSql}) AND use_release.mode=(${scope.modeSql})
        AND use_release.provider='apple'
        AND (use_release.org_id IS (${scope.orgIdSql}) OR use_release.org_id IS NULL))
    OR EXISTS (SELECT 1 FROM passes legacy_scope_pass
      WHERE ${legacyPassSql('legacy_scope_pass', scope)})))`;
}

export interface ScopedReleaseHead {
  templateId: string;
  release: { id: string; generation: number; version: string; candidateHash: string };
}

/** A snapshot of all selected heads, including nulls for unusable templates. */
export function templateReleaseHeadsSql(idsSql: string, orgIdSql: string, modeSql: string): string {
  return `(SELECT json_group_array(json_object('templateId',template_id,'release',
      json_object('id',release_id,'generation',generation,'version',version,'candidateHash',candidate_hash)))
    FROM (SELECT ids.template_id, r.id AS release_id, r.generation, r.version, r.candidate_hash
      FROM (${idsSql}) ids
      LEFT JOIN templates scoped_t ON scoped_t.id=ids.template_id
        AND (scoped_t.org_id=${orgIdSql} OR scoped_t.org_id IS NULL) AND scoped_t.status!='deleted'
      LEFT JOIN template_releases r ON r.id=(${effectiveReleaseIdSql({
        templateIdSql: 'scoped_t.id',
        orgIdSql,
        modeSql,
        providerSql: "'apple'",
      })})
      ORDER BY ids.template_id))`;
}

export interface SessionReleaseStamp {
  templateId: string;
  id: string;
  generation: number;
  version: string;
  candidateHash: string;
}

export interface LegacyIdentityStamp {
  version: string;
  identityId: string;
  identityRevision: number;
}

export interface SessionLegacyStamp {
  templateId: string;
  versions: readonly string[];
  identities: readonly LegacyIdentityStamp[];
}

export interface TemplateStamps {
  releases: SessionReleaseStamp[];
  legacy: SessionLegacyStamp[];
}

interface TemplateStampRow {
  template_id: string;
  release_id: string | null;
  generation: number | null;
  version: string | null;
  candidate_hash: string | null;
  legacy_evidence: string | null;
}

/** A bounded stamp read that can share one D1 batch with recipient and pass authority. */
export function captureTemplateStampsStmt(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateIds: readonly string[],
): D1PreparedStatement | null {
  if (
    templateIds.length > 20 ||
    new Set(templateIds).size !== templateIds.length ||
    templateIds.some((id) => typeof id !== 'string' || !id || id.length > 64)
  )
    return null;
  if (templateIds.length === 0) return stmt(db, 'SELECT 1 WHERE 0');
  const scope = {
    templateIdSql: 't.id',
    orgIdSql: 'scope.org_id',
    modeSql: 'scope.mode',
    providerSql: "'apple'",
  };
  return stmt(
    db,
    `SELECT selected.value AS template_id, head.id AS release_id, head.generation, head.version,
      head.candidate_hash,
      CASE WHEN t.id IS NOT NULL AND head.id IS NULL THEN
        (SELECT json_group_array(json_object('version',template_version,'identityId',identity_id,
          'identityRevision',identity_revision)) FROM (
          SELECT DISTINCT p.template_version,p.identity_id,si.revision AS identity_revision FROM passes p
          JOIN signing_identities si ON si.id=p.identity_id WHERE ${legacyPassSql('p', scope)}
          ORDER BY p.template_version,p.identity_id,si.revision
        )) END AS legacy_evidence
    FROM json_each(?) selected CROSS JOIN (SELECT ? AS org_id, ? AS mode) scope
    LEFT JOIN templates t ON t.id=selected.value AND (t.org_id=scope.org_id OR t.org_id IS NULL)
      AND t.status!='deleted'
    LEFT JOIN template_releases head ON head.id=COALESCE((${effectiveReleaseIdSql(scope)}),
      (SELECT lr.id FROM template_releases lr WHERE lr.template_id=t.id AND lr.mode=scope.mode
        AND lr.provider='apple'
        AND NOT EXISTS (SELECT 1 FROM passes fb WHERE ${legacyPassSql('fb', scope)})
        AND ((lr.org_id=scope.org_id AND (t.origin='uploaded' OR t.org_id=scope.org_id))
          OR (lr.org_id IS NULL AND t.origin='baked' AND t.org_id IS NULL))
        ORDER BY (lr.org_id IS NOT NULL) DESC, lr.generation DESC LIMIT 1))`,
    [JSON.stringify(templateIds), orgId, mode],
  );
}

/** Decode only the original selected IDs, rejecting missing, duplicate or malformed stamps. */
export function templateStampsFromResult(
  templateIds: readonly string[],
  result: D1Result | undefined,
): TemplateStamps | null {
  if (
    templateIds.length > 20 ||
    new Set(templateIds).size !== templateIds.length ||
    templateIds.some((id) => typeof id !== 'string' || !id || id.length > 64) ||
    !result
  )
    return null;
  const rows = (result.results ?? []) as unknown as TemplateStampRow[];
  if (
    rows.length !== templateIds.length ||
    new Set(rows.map((row) => row.template_id)).size !== rows.length ||
    rows.some((row) => !templateIds.includes(row.template_id))
  )
    return null;
  const stamps: TemplateStamps = { releases: [], legacy: [] };
  for (const row of rows) {
    if (
      row.release_id !== null &&
      row.generation !== null &&
      row.version !== null &&
      row.candidate_hash !== null
    ) {
      stamps.releases.push({
        templateId: row.template_id,
        id: row.release_id,
        generation: row.generation,
        version: row.version,
        candidateHash: row.candidate_hash,
      });
    } else {
      let identities: unknown;
      try {
        identities = row.legacy_evidence === null ? null : JSON.parse(row.legacy_evidence);
      } catch {
        return null;
      }
      if (!Array.isArray(identities) || identities.length === 0) return null;
      const versions = [
        ...new Set(identities.map((identity: LegacyIdentityStamp) => identity.version)),
      ];
      stamps.legacy.push({ templateId: row.template_id, versions, identities });
    }
  }
  return stampsValid(stamps.releases, stamps.legacy) ? stamps : null;
}

/** Capture every selected template's effective head or exact legacy version set. */
export async function captureTemplateStamps(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateIds: readonly string[],
): Promise<TemplateStamps | null> {
  if (!templateIds.length) return { releases: [], legacy: [] };
  const query = captureTemplateStampsStmt(db, orgId, mode, templateIds);
  if (!query) return null;
  return templateStampsFromResult(templateIds, await query.all());
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

/** Captured stamps are complete: every template has one head or an exact legacy version set, none repeated. */
function stampsValid(
  releases: readonly SessionReleaseStamp[],
  legacy: readonly SessionLegacyStamp[],
): boolean {
  if (!Array.isArray(releases) || !Array.isArray(legacy) || releases.length + legacy.length > 20)
    return false;
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
    return false;
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
      return false;
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
        return false;
      const key = JSON.stringify([
        identity.version,
        identity.identityId,
        identity.identityRevision,
      ]);
      if (evidence.has(key)) return false;
      evidence.add(key);
      versions.add(identity.version);
    }
    if (
      versions.size !== item.versions.length ||
      item.versions.some(
        (version: unknown) => typeof version !== 'string' || !versions.has(version),
      )
    )
      return false;
    seen.add(item.templateId);
  }
  return true;
}
