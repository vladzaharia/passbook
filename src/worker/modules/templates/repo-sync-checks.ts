import type { Check } from '../../platform/authority-checks.ts';
import type { DenyReason } from '../../platform/errors.ts';
import type { VersionExtrasSnapshot } from './repo-preview-extras.ts';
import type { BakedTemplateSnapshot, BakedVersionSnapshot } from './repo-sync.ts';

const stale = (sql: (bind: (v: string | number | null) => string) => string): Check =>
  ({ reason: 'stale' as DenyReason, ok: (b) => sql((v) => b.bind(v)) }) satisfies Check;

/** The template is as the sync read it: same org and origin (an administrator's reassignment refuses the sync). */
export const bakedTemplateUnchanged = (id: string, s: BakedTemplateSnapshot | null): Check =>
  stale((p) =>
    s
      ? `EXISTS (SELECT 1 FROM templates WHERE id = ${p(id)} AND org_id IS ${p(s.org_id)} AND origin = ${p(s.origin)})`
      : `NOT EXISTS (SELECT 1 FROM templates WHERE id = ${p(id)})`,
  );

export const bakedOrgUnchanged = (slug: string, id: string | null): Check =>
  stale((p) =>
    id
      ? `EXISTS (SELECT 1 FROM orgs WHERE slug = ${p(slug)} AND id = ${p(id)})`
      : `NOT EXISTS (SELECT 1 FROM orgs WHERE slug = ${p(slug)})`,
  );

export const bakedVersionUnchanged = (
  id: string,
  version: string,
  s: BakedVersionSnapshot | null,
): Check =>
  stale((p) =>
    s
      ? `EXISTS (SELECT 1 FROM template_versions WHERE template_id = ${p(id)} AND version = ${p(version)}
          AND manifest = ${p(s.manifest)} AND pass_json = ${p(s.pass_json)} AND assets = ${p(s.assets)}
          AND report = ${p(s.report)} AND build_key IS ${p(s.build_key)} AND created_by IS ${p(s.created_by)}
          AND created_at = ${p(s.created_at)})`
      : `NOT EXISTS (SELECT 1 FROM template_versions WHERE template_id = ${p(id)} AND version = ${p(version)})`,
  );

/** No extra row or seal changed after the snapshot. */
export const bakedExtrasUnchanged = (
  id: string,
  version: string,
  s: VersionExtrasSnapshot,
): Check =>
  stale(
    (
      p,
    ) => `(SELECT extras_hash FROM template_version_extra_sets WHERE template_id = ${p(id)} AND version = ${p(version)}) IS ${p(s.seal)}
      AND (SELECT COUNT(*) FROM template_version_extras WHERE template_id = ${p(id)} AND version = ${p(version)}) = ${p(s.extras.length)}
      AND NOT EXISTS (
        SELECT 1 FROM template_version_extras e
        WHERE e.template_id = ${p(id)} AND e.version = ${p(version)} AND NOT EXISTS (
          SELECT 1 FROM json_each(${p(JSON.stringify(s.extras))}) j WHERE e.name = json_extract(j.value, '$.name')
            AND e.size = json_extract(j.value, '$.size')
            AND e.sha1 = json_extract(j.value, '$.sha1')
            AND e.sha256 = json_extract(j.value, '$.sha256')
            AND e.r2_key = json_extract(j.value, '$.r2Key')
        ))`,
  );
