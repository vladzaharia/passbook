import type { Json, TemplateManifest } from '../../types.ts';
import { isGenerated } from './files.ts';
import { isObj } from './map.ts';
import type { PackageDoc } from './types.ts';

/**
 * A copy without what is not content. `org` and `blueprint` never belong to a fork; `name`
 * stays and always comes from ours (the manifest rule). Generated strips and tooling are gone,
 * because the save pipeline draws them again.
 */
export function normalize(doc: PackageDoc): PackageDoc {
  const { org: _org, blueprint: _blueprint, ...manifest } = structuredClone(doc.manifest);
  return {
    passJson: structuredClone(doc.passJson),
    manifest: manifest as TemplateManifest,
    files: Object.fromEntries(Object.entries(doc.files).filter(([name]) => !isGenerated(name))),
  };
}

/** Where each document pins a format version, for the equal-or-invalid check. */
export const VERSION_SITES = [
  { part: 'scan.display', key: 'scan', sub: 'display', version: 'v' },
  { part: 'wallets', key: 'wallets', sub: undefined, version: 'schema' },
] as const;

export function versionOf(doc: PackageDoc, site: (typeof VERSION_SITES)[number]): Json | undefined {
  const root = (doc.manifest as unknown as Record<string, Json>)[site.key];
  const node = site.sub && isObj(root) ? root[site.sub] : root;
  return isObj(node) ? node[site.version] : undefined;
}

/** Replaces the part's subtree in `doc` with ours', so that it merges to ours untouched. */
export function alignTo(doc: PackageDoc, ours: PackageDoc, site: (typeof VERSION_SITES)[number]) {
  const [d, o] = [doc.manifest, ours.manifest].map((m) => m as unknown as Record<string, Json>);
  const [dr, or] = [d?.[site.key], o?.[site.key]];
  if (!site.sub) {
    if (or === undefined) delete (d as Record<string, Json>)[site.key];
    else (d as Record<string, Json>)[site.key] = structuredClone(or);
    return;
  }
  if (!isObj(dr)) return;
  const src = isObj(or) ? or[site.sub] : undefined;
  if (src === undefined) delete dr[site.sub];
  else dr[site.sub] = structuredClone(src);
}
