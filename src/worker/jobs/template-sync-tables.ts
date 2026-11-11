/**
 * Every table the baked sync writes (orgs, settings, templates, versions, extras, hashes, releases and the
 * event cache a release invalidates). The one list: read-path write allowlists derive from it.
 */
export const TEMPLATE_SYNC_TABLES = [
  'orgs',
  'settings',
  'templates',
  'template_versions',
  'template_version_extras',
  'template_version_extra_sets',
  'template_version_hashes',
  'template_releases',
  'scan_events',
] as const;
