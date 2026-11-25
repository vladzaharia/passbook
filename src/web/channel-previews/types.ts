import type { Personalization } from '@/passkit/types.ts';
import type { PreviewChannel } from '@/shared/copy/previews.ts';

export type { PreviewChannel };
/** Switcher order. */
export const PREVIEW_CHANNELS: readonly PreviewChannel[] = [
  'apple',
  'google',
  'samsung',
  'mobile',
  'paper',
];

/** A file of the template version: its size decides what a wallet can use. */
export interface PreviewAsset {
  name: string;
  slot: string;
  scale: 1 | 2 | 3;
  width?: number | undefined;
  height?: number | undefined;
}

/** What every channel draws from: the built pass, its template and its files. */
export interface PreviewSource {
  passJson: Record<string, unknown>;
  assetBaseUrl: string;
  /** Files the preview can load, from the dry run or the pass. */
  assetNames: readonly string[];
  /** Explicit URLs by file name (a staged image as a data URL); they replace assetBaseUrl + name. */
  assetUrls?: Record<string, string> | undefined;
  manifest: Record<string, unknown>;
  /** The version's own files; a name not listed is a per-pass file and never reaches a wallet. */
  assets: readonly PreviewAsset[];
  /** The values the pass was built from: the template's sample, or the pass's own. */
  input: Personalization;
  /** A pass in a developer org: every channel carries the TEST PREVIEW band. */
  testBand?: boolean | undefined;
  /** The organization's `org.website`: the Samsung app link, else the holder portal. */
  website?: string | undefined;
  /** The organization's effective `org.timeZone`: offsetless wallet dates read in it, and a US or Canadian one previews paper on Letter. */
  timeZone?: string | undefined;
}
