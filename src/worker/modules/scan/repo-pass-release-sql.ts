import { effectiveReleaseIdSql } from '../templates/repo-release-heads.ts';

/**
 * The release a pass is judged against: the effective head when the head's version is the pass's own
 * or has the same build (so a compatible edit reaches existing passes), otherwise the pass's own
 * issued release. Never the bare head: a newer, withdrawn or missing head does not refuse a pass.
 * `pass` is a trusted alias of the passes row.
 */
export function usedReleaseIdSql(pass: string): string {
  const head = effectiveReleaseIdSql({
    templateIdSql: `${pass}.template_id`,
    orgIdSql: `${pass}.org_id`,
    modeSql: `${pass}.mode`,
    providerSql: "'apple'",
  });
  return `COALESCE((SELECT h.id FROM template_releases h
    WHERE h.id = (${head}) AND (h.version = ${pass}.template_version OR EXISTS (
      SELECT 1 FROM template_versions pinned JOIN template_versions hv
        ON hv.template_id = pinned.template_id AND hv.version = h.version
      WHERE pinned.template_id = ${pass}.template_id AND pinned.version = ${pass}.template_version
        AND pinned.build_key IS NOT NULL AND pinned.build_key = hv.build_key))), ${pass}.release_id)`;
}
