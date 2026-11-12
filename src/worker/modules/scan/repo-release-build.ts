import type { SqlValue } from '../../platform/db.ts';

type Predicate = { sql: string; params: SqlValue[] };

/** Compare the immutable pinned build with a scoped release's version. */
export function releaseBuildCompatibilitySql(versionSql: string): string {
  return `(p.template_version=${versionSql} OR EXISTS (
    SELECT 1 FROM template_versions pinned JOIN template_versions active
      ON active.template_id=pinned.template_id AND active.version=${versionSql}
    WHERE pinned.template_id=p.template_id AND pinned.version=p.template_version
      AND pinned.build_key IS NOT NULL AND pinned.build_key=active.build_key
  ))`;
}

export function releaseBuildCompatibilityPredicate(version: string): Predicate {
  return { sql: releaseBuildCompatibilitySql('?'), params: [version, version] };
}
