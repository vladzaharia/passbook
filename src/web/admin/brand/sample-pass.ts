import type { PassJson, Personalization } from '@/passkit/types.ts';
import type { PreviewAsset, PreviewSource } from '@/web/channel-previews/types.ts';
import { HEX } from '../orgs/branding.ts';

/** PassBook's blueprint blue: what a pass shows while the org has set no colours. Pass art, not UI. */
const BLUEPRINT = { background: '#1d3fd0', foreground: '#ffffff', label: '#c7d2fe' } as const;

export interface SampleInput {
  name: string;
  background: string;
  foreground: string;
  label: string;
  logoHasName: boolean;
}

/** A membership card in the org's colours, for the preview. Unset colours show the blueprint's. */
export function samplePassJson(d: SampleInput): PassJson {
  const set = [d.background, d.foreground, d.label].every((c) => HEX.test(c));
  const c = set
    ? { background: d.background, foreground: d.foreground, label: d.label }
    : BLUEPRINT;
  const name = d.name.trim() || 'Organization';
  return {
    formatVersion: 1,
    passTypeIdentifier: 'pass.example',
    teamIdentifier: 'EXAMPLE',
    serialNumber: 'sample',
    organizationName: name,
    description: `${name} membership card`,
    ...(d.logoHasName ? {} : { logoText: name }),
    backgroundColor: c.background,
    foregroundColor: c.foreground,
    labelColor: c.label,
    generic: {
      headerFields: [{ key: 'plan', label: 'Plan', value: 'Monthly' }],
      primaryFields: [{ key: 'name', label: 'Member', value: 'Maya Chen' }],
      secondaryFields: [
        { key: 'paid', label: 'Paid through', value: 'Dec 31' },
        { key: 'guests', label: 'Guests left', value: '2' },
      ],
    },
    barcodes: [{ format: 'PKBarcodeFormatQR', message: 'M-1042', messageEncoding: 'iso-8859-1' }],
  } as unknown as PassJson;
}

/** The least a manifest needs for the wallet compilers: used while the org has no template. */
const SAMPLE_MANIFEST = { name: 'Sample', inputs: {}, bindings: [] };

export interface SampleImage {
  url: string;
  /** Pixels at @3x. */
  w: number;
  h: number;
}

/** A logo and an icon as file names, URLs and sizes: what a pass view and the wallet compilers read. */
function imageFiles(logo?: SampleImage, icon?: SampleImage) {
  const urls: Record<string, string> = {};
  const assets: PreviewAsset[] = [];
  for (const [slot, img] of [
    ['logo', logo],
    ['icon', icon],
  ] as const) {
    if (!img) continue;
    for (const scale of [2, 3] as const) {
      const name = `${slot}@${scale}x.png`;
      urls[name] = img.url;
      assets.push({
        name,
        slot,
        scale,
        width: Math.round((img.w * scale) / 3),
        height: Math.round((img.h * scale) / 3),
      });
    }
  }
  return { urls, assets };
}

/**
 * What the wallet, page and paper previews draw from: the sample pass with the org's logo and
 * icon by URL (a saved image's path, or a staged one as a data URL). A template supplies its
 * manifest and sample values for Paper.
 */
export function sampleSource(
  passJson: PassJson,
  images: { logo?: SampleImage | undefined; icon?: SampleImage | undefined } = {},
  template?: { manifest: Record<string, unknown>; sample: Personalization },
): PreviewSource {
  const { urls, assets } = imageFiles(images.logo, images.icon);
  return {
    passJson: passJson as unknown as Record<string, unknown>,
    assetBaseUrl: '/',
    assetNames: Object.keys(urls),
    assetUrls: urls,
    manifest: template?.manifest ?? SAMPLE_MANIFEST,
    assets,
    input: template?.sample ?? ({} as Personalization),
  };
}
