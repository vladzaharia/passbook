import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { versionAssets } from '../../channel-previews/source.ts';
import type { PreviewAsset, PreviewSource } from '../../channel-previews/types.ts';
import type { Built } from './live.ts';
import type { BlueprintPreview, InputSchema, InputValues } from './model.ts';

/** What the page needs of a template, whether it is a starter blueprint or the visitor's own. */
export interface PgTemplate {
  id: string;
  name: string;
  /** One short line under the picker. */
  hint: string;
  inputs: InputSchema;
  sample: InputValues;
  manifest: Record<string, unknown>;
  assets: PreviewAsset[];
  /** A blueprint is a design to start from: it previews, and never issues a pass. */
  issuable: boolean;
  /** The starter's prebuilt sample, so an anonymous visitor's browser calls nothing. */
  fixed?: { built: Built; paper: BlueprintPreview['paper'] };
}

export const fromBlueprint = (b: BlueprintPreview): PgTemplate => ({
  id: b.id,
  name: b.name,
  hint: 'Blueprint · preview only',
  inputs: b.inputs,
  sample: b.sample,
  manifest: { ...b.manifest, inputs: b.inputs },
  assets: b.assets,
  issuable: false,
  fixed: {
    built: { passJson: b.passJson, assetBaseUrl: b.assetBaseUrl, assetNames: b.assetNames },
    paper: b.paper,
  },
});

export const fromDetail = (t: z.infer<typeof TemplateDetailSchema>): PgTemplate => ({
  id: t.id,
  name: t.name,
  hint: `Your sandbox template · release ${t.activeVersion ?? '1'}`,
  inputs: t.inputSchema as InputSchema,
  sample: t.sample as InputValues,
  manifest: t.manifest as Record<string, unknown>,
  assets: versionAssets(t),
  issuable: true,
});

/** The sample with the visitor's edits over it; an edit of `null` takes the field out. */
export function valuesOf(t: PgTemplate, edits: InputValues): InputValues {
  const out: InputValues = { ...t.sample, ...edits };
  for (const [key, value] of Object.entries(out)) if (value === null) delete out[key];
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What differs from the sample: the only part a link or a "was" tag needs. */
export function editsOf(t: PgTemplate, values: InputValues): InputValues {
  const out: InputValues = {};
  for (const [key, value] of Object.entries(values))
    if (!same(value, t.sample[key])) out[key] = value;
  for (const key of Object.keys(t.sample)) if (!(key in values)) out[key] = null;
  return out;
}

export const sourceOf = (t: PgTemplate, built: Built, input: InputValues): PreviewSource => ({
  passJson: built.passJson,
  assetBaseUrl: built.assetBaseUrl,
  assetNames: built.assetNames,
  manifest: t.manifest,
  assets: t.assets,
  input: input as PreviewSource['input'],
  testBand: true,
});
