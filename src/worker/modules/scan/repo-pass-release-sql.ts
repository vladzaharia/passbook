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

/**
 * True when the pass's own issued release says the same as its head about everything a scanner
 * sees or may do: version, content hash, adapter revision and capabilities, audience policy
 * revision and scope. Then the head is a republish and the pass is used under its own release;
 * otherwise the head is a change. `pass` and `head` are trusted aliases (passes, template_releases).
 */
export function ownReleaseSaysSameSql(pass: string, head: string): string {
  return `(${head}.id IS NOT ${pass}.release_id AND EXISTS (
    SELECT 1 FROM template_releases own_release WHERE own_release.id=${pass}.release_id
      AND own_release.version=${head}.version AND own_release.content_hash=${head}.content_hash
      AND own_release.adapter_revision=${head}.adapter_revision
      AND own_release.adapter_capabilities=${head}.adapter_capabilities
      AND own_release.audience_policy_revision=${head}.audience_policy_revision
      AND own_release.org_id IS ${head}.org_id))`;
}

/** The id of the release a scan read captures: the pass's own when the head only republishes it. */
export function snapshotReleaseIdSql(pass: string, head: string): string {
  return `CASE WHEN ${ownReleaseSaysSameSql(pass, head)} THEN ${pass}.release_id ELSE ${head}.id END`;
}
