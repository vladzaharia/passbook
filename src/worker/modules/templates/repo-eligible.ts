import type { TemplateManifest } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { EligibleTemplate } from '../../../shared/contracts/template-releases.ts';
import { scanOf } from '../../../shared/scan-defaults.ts';
import { all } from '../../platform/db.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import { effectiveReleaseIdSql } from './repo-release-heads.ts';
import type { ReleaseProvider } from './repo-releases.ts';

export interface EligibleReleaseQuery {
  orgId: string;
  mode: Mode;
  provider: ReleaseProvider;
  cursor?: string;
  limit: number;
}

/** List effective releases without exposing manifests or other release internals. */
export async function listEligibleReleases(
  db: D1Database,
  query: EligibleReleaseQuery,
  authority: TenantPassWrite,
  now: number,
): Promise<{ items: EligibleTemplate[]; nextCursor: string | null }> {
  const rows = await all<Omit<EligibleTemplate, 'supportsCheckIn'> & { manifest: string }>(
    db,
    `WITH scope(org_id, mode, provider) AS (VALUES (?, ?, ?))
     SELECT t.id AS templateId, t.name, t.org_id AS templateOrgId, t.origin,
       r.id AS releaseId, r.generation AS releaseGeneration, r.version,
       r.candidate_hash AS candidateHash, v.manifest
     FROM scope s
     JOIN templates t ON (t.org_id = s.org_id OR t.org_id IS NULL)
     JOIN template_releases r ON r.id = (${effectiveReleaseIdSql({
       templateIdSql: 't.id',
       orgIdSql: 's.org_id',
       modeSql: 's.mode',
       providerSql: 's.provider',
     })})
     JOIN template_versions v ON v.template_id = r.template_id AND v.version = r.version
     WHERE t.status = 'active' AND s.mode = ?
       AND ${tenantPassAuthoritySql(authority, 's')}
       ${query.cursor === undefined ? '' : 'AND t.id > ?'}
     ORDER BY t.id ASC LIMIT ?`,
    [
      query.orgId,
      query.mode,
      query.provider,
      authority.mode,
      ...tenantPassAuthorityParams(authority, now),
      ...(query.cursor === undefined ? [] : [query.cursor]),
      query.limit + 1,
    ],
  );
  const page = rows.slice(0, query.limit);
  return {
    items: page.map(({ manifest, ...item }) => ({
      ...item,
      supportsCheckIn: scanOf(JSON.parse(manifest) as TemplateManifest).actions.some(
        (a) => a.kind === 'check_in',
      ),
    })),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.templateId ?? null) : null,
  };
}
