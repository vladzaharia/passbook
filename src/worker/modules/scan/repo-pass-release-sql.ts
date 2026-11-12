import { effectiveReleaseIdSql } from '../templates/repo-release-heads.ts';

/**
 * The release whose scan policy applies to a pass: the effective head when there is one (the org's
 * current intent for re-entry, roles, actions and capacity), otherwise the pass's own issued release
 * (archived template, pre-cutover). Pass content (barcode validity, fields, display data) is read
 * from the pass's own version, never from this release. `pass` is a trusted alias of the passes row.
 */
export function usedReleaseIdSql(pass: string): string {
  const head = effectiveReleaseIdSql({
    templateIdSql: `${pass}.template_id`,
    orgIdSql: `${pass}.org_id`,
    modeSql: `${pass}.mode`,
    providerSql: "'apple'",
  });
  return `COALESCE((${head}), ${pass}.release_id)`;
}
