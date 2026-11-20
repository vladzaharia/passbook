import type { z } from 'zod';
import type { Personalization } from '@/passkit/types.ts';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import type { PreviewAsset, PreviewSource } from './types.ts';

type Template = z.infer<typeof TemplateDetailSchema>;

/** The built pass and the files it can load, as the dry run or the pass itself gives them. */
export interface BuiltPass {
  passJson: Record<string, unknown>;
  assetBaseUrl: string;
  assetNames: readonly string[];
}

/** The files of the template's shown version, for their sizes and to tell per-pass files apart. */
export function versionAssets(template: Template, version?: string): PreviewAsset[] {
  const wanted = version ?? template.activeVersion;
  const found = template.versions.find((v) => v.version === wanted) ?? template.versions[0];
  return (found?.assets ?? []).map((a) => ({
    name: a.name,
    slot: a.slot,
    scale: a.scale,
    ...(a.width ? { width: a.width } : {}),
    ...(a.height ? { height: a.height } : {}),
  }));
}

/**
 * What every channel draws from. `input` is the template's sample unless a real pass supplies its
 * own values. Null until the template and the built pass have both arrived.
 */
export function previewSource(
  built: BuiltPass | undefined,
  template: Template | undefined,
  options: { input?: Personalization; version?: string } = {},
): PreviewSource | null {
  if (!built || !template) return null;
  return {
    passJson: built.passJson,
    assetBaseUrl: built.assetBaseUrl,
    assetNames: built.assetNames,
    manifest: template.manifest as Record<string, unknown>,
    assets: versionAssets(template, options.version),
    input: options.input ?? template.sample,
  };
}
