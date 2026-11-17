import {
  APPLE_ADAPTER_CAPABILITIES,
  APPLE_ADAPTER_REVISION,
  AUDIENCE_POLICY_REVISION,
} from './release-content.ts';

/** Trusted SQL column references or literals only; no placeholders (expressions may be repeated). */
export interface ReleaseScopeSql {
  templateIdSql: string;
  orgIdSql: string;
  modeSql: string;
  providerSql: string;
}

const quotedCapabilities = `'${JSON.stringify(APPLE_ADAPTER_CAPABILITIES).replace(/'/g, "''")}'`;

/**
 * Id of the release a scope issues from, or no row. The head comes from `template_release_heads` with the
 * precedence `releaseHead` (platform/authority-checks.ts) applies in a grant: the scope org's head first, then
 * the platform head, and the platform head only for an unassigned baked template. Provenance is checked on that
 * one row: a legacy release is effective only as the scope's first release, an approved one needs its candidate
 * and approval, and a system or approved release is not effective when the version's saved content hash differs
 * from the released one (legacy rows are exempt; a version never hashed is verified from its bytes and then
 * saved, see `verifyStoredContent`). Correlated and parameter-free.
 */
export function effectiveReleaseIdSql(scope: ReleaseScopeSql): string {
  const { templateIdSql: t, orgIdSql: o, modeSql: m, providerSql: p } = scope;
  // The newest generation per scope, read straight from the releases so the whole
  // (template, mode, provider, org) index prefix applies; template_release_heads is the same rows.
  const head = (guard: string, orgMatch: string) => `SELECT hr.id FROM template_releases hr
        WHERE ${guard} AND hr.template_id = et.id AND hr.mode = (${m}) AND hr.provider = (${p})
          AND ${orgMatch} ORDER BY hr.generation DESC LIMIT 1`;
  return `SELECT er.id FROM templates et
    JOIN template_releases er ON er.id = COALESCE(
      (${head(`(${o}) IS NOT NULL AND (et.origin = 'uploaded' OR et.org_id = (${o}))`, `hr.org_id = (${o})`)}),
      (${head("et.origin = 'baked' AND et.org_id IS NULL", 'hr.org_id IS NULL')}))
    JOIN template_versions ev ON ev.template_id = er.template_id AND ev.version = er.version
    WHERE et.id = (${t}) AND (${p}) = 'apple' AND et.status = 'active'
      AND (et.org_id IS NULL OR et.org_id = (${o}))
      AND (er.adapter_revision = ${APPLE_ADAPTER_REVISION} AND er.adapter_capabilities = ${quotedCapabilities}
        AND er.audience_policy_revision = ${AUDIENCE_POLICY_REVISION})
      AND ((er.source = 'system' AND er.action = 'system' AND et.origin = 'baked' AND er.org_id IS et.org_id
          AND er.version = et.active_version AND er.candidate_id IS NULL AND er.approval_id IS NULL)
        OR (er.source = 'legacy' AND er.action = 'legacy' AND et.origin = 'uploaded'
          AND er.org_id IS NOT NULL AND er.org_id IS (${o}) AND er.version = et.active_version)
        OR (er.source = 'approved' AND er.action IN ('release', 'rollback') AND et.origin = 'uploaded'
          AND er.org_id IS NOT NULL AND er.org_id IS (${o})
          AND EXISTS (SELECT 1 FROM template_candidates c JOIN template_approvals a ON a.candidate_id = c.id
            WHERE (c.id = er.candidate_id AND a.id = er.approval_id AND c.template_id = er.template_id
                AND c.org_id IS er.org_id)
              AND (c.mode = er.mode AND c.provider = er.provider AND c.version = er.version
                AND c.candidate_hash = er.candidate_hash)
              AND (a.candidate_hash = c.candidate_hash AND c.content_hash = er.content_hash
                AND c.adapter_revision = er.adapter_revision AND c.adapter_capabilities = er.adapter_capabilities)
              AND (c.audience_policy_revision = er.audience_policy_revision
                AND ev.created_by IS c.version_author_id AND a.reviewer_id != c.author_id
                AND (c.version_author_id IS NULL OR a.reviewer_id != c.version_author_id)))))
      AND (er.source = 'legacy' OR NOT EXISTS (SELECT 1 FROM template_version_hashes vh
        WHERE vh.template_id = er.template_id AND vh.version = er.version AND vh.content_hash != er.content_hash))
    LIMIT 1`;
}
