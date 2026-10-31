import type {
  AssetEntry,
  PassStyle,
  TemplateManifest,
  ValidationReport,
} from '../../../passkit/types.ts';

export type BakedAsset = Omit<AssetEntry, 'source'> & {
  source: { kind: 'static'; path: string };
};

/** One template package from templates/<slug>/, as emitted by tools/build-templates.ts. */
export interface BakedTemplate {
  /** `baked:<slug>` */
  id: string;
  slug: string;
  /** Content hash; also the static asset directory. */
  version: string;
  name: string;
  description: string | null;
  /** Owning org from the manifest `org` key. Null = platform starter. */
  org: { slug: string; name: string } | null;
  styles: PassStyle[];
  manifest: TemplateManifest;
  /** Stored as parsed from pass.json; server fields are filled at build time. */
  passJson: Record<string, unknown>;
  assets: BakedAsset[];
  /** Static files outside the pass bundle (web preview art). */
  extras: { name: string; size: number; sha1: string; path: string }[];
  report: ValidationReport;
}
