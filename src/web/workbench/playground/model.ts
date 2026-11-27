import type { PreviewAsset } from '../../channel-previews/types.ts';

/** One property of an input schema, as the form and the sample read it. */
export interface InputProp {
  type?: string;
  format?: string;
  enum?: string[];
  'x-label'?: string;
  'x-group'?: string;
  'x-order'?: number;
  'x-help'?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

export interface InputSchema {
  required?: string[];
  properties?: Record<string, InputProp>;
}

export type InputValues = Record<string, unknown>;

/** What every channel draws for one blueprint's sample: built at deploy, so a visitor calls nothing. */
export interface BlueprintPreview {
  /** `baked:starter-store-card`, the id the signed-in API takes. */
  id: string;
  slug: string;
  name: string;
  description: string | null;
  inputs: InputSchema;
  sample: InputValues;
  manifest: Record<string, unknown>;
  /** The template's own pass.json, before the sample is bound: the live page plans from it. */
  source?: Record<string, unknown>;
  /** The origin the stored card was planned at; the live card plans at the same one. */
  origin: string;
  passJson: Record<string, unknown>;
  /** The files' own base: static, so the cards load them without the API. */
  assetBaseUrl: string;
  assetNames: string[];
  assets: PreviewAsset[];
  /** The printed ticket, drawn once as a static image. */
  paper: { src: string; width: number; height: number };
}

export interface BlueprintPreviews {
  schema: 1;
  items: BlueprintPreview[];
}

export const DEFAULT_BLUEPRINT = 'baked:starter-store-card';
