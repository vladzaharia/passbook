import type { TemplateManifest } from '../../types.ts';
import { isGenerated } from './files.ts';
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
