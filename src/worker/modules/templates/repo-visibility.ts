/**
 * The templates an org may see: its own, and the platform's that are offered to it: baked, shared with
 * every org, or already worked with (the org holds a release or candidate, which unsharing never takes
 * away). A staged platform upload is for the platform. `org` is an SQL expression for the org (`a.org_id`
 * in a grant, `?` in a query, which is then bound `ORG_BINDS` times). One predicate for every reader.
 */
export const ORG_BINDS = 3;

export function templateVisibleSql(alias: string, org: string): string {
  return `(${alias}.org_id = ${org} OR (${alias}.org_id IS NULL AND (${alias}.origin = 'baked' OR ${alias}.shared = 1
    OR EXISTS (SELECT 1 FROM template_releases vr WHERE vr.template_id = ${alias}.id AND vr.org_id = ${org})
    OR EXISTS (SELECT 1 FROM template_candidates vc WHERE vc.template_id = ${alias}.id AND vc.org_id = ${org}))))`;
}

/** The bound values of `templateVisibleSql(alias, '?')`. */
export const visibleBinds = (orgId: string): string[] =>
  Array.from({ length: ORG_BINDS }, () => orgId);
