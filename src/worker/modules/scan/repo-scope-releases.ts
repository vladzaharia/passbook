import type { Mode } from '../../../shared/contracts/common.ts';
import { type SqlValue, stmt } from '../../platform/db.ts';
import { effectiveReleaseIdSql } from '../templates/repo-release-heads.ts';
import type { ReleaseScopeSql } from '../templates/repo-releases.ts';
import {
  effectiveReleaseBindingPredicate,
  legacyPassSql,
  releaseHeadsComplete,
  sessionTemplateStampsPredicate,
} from './repo-scope-release-predicates.ts';

export {
  releaseHeadsComplete,
  sessionTemplateStampsPredicate,
} from './repo-scope-release-predicates.ts';

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

export function releaseHeadsOf(
  rows: readonly { id: string; release: ScopedReleaseHead['release'] }[],
): string {
  return JSON.stringify(rows.map((row) => ({ templateId: row.id, release: row.release })));
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
        AND lr.provider='apple' AND (lr.org_id IS scope.org_id OR lr.org_id IS NULL)
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
  return sessionTemplateStampsPredicate(
    stamps.releases,
    stamps.legacy,
    'scope.org_id',
    'scope.mode',
  ).sql === '0'
    ? null
    : stamps;
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

/** Revalidate the precise heads used by an earlier scope or count evaluation. */
export function releaseHeadsPredicate(
  snapshot: string,
  orgIdSql: string,
  modeSql: string,
): { sql: string; params: SqlValue[] } {
  if (!releaseHeadsComplete(snapshot)) return { sql: '0', params: [] };
  const predicate = effectiveReleaseBindingPredicate(
    {
      idSql: "json_extract(h.value,'$.release.id')",
      generationSql: "json_extract(h.value,'$.release.generation')",
      versionSql: "json_extract(h.value,'$.release.version')",
      candidateHashSql: "json_extract(h.value,'$.release.candidateHash')",
    },
    {
      templateIdSql: 'scoped_t.id',
      orgIdSql,
      modeSql,
      providerSql: "'apple'",
    },
  );
  return {
    sql: `NOT EXISTS (SELECT 1 FROM json_each(?) h
      LEFT JOIN templates scoped_t ON scoped_t.id=json_extract(h.value,'$.templateId')
        AND (scoped_t.org_id=${orgIdSql} OR scoped_t.org_id IS NULL) AND scoped_t.status!='deleted'
      WHERE scoped_t.id IS NULL OR COALESCE((${predicate}),0)!=1)`,
    params: [snapshot],
  };
}
