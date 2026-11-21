import type { PassJson, Personalization } from '@/passkit/types.ts';
import type { PreviewSource } from '@/web/channel-previews/types.ts';
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

/** What the wallet, page and paper previews draw from. Images are not wired: colours and name only. */
export function sampleSource(passJson: PassJson): PreviewSource {
  return {
    passJson: passJson as unknown as Record<string, unknown>,
    assetBaseUrl: '/',
    assetNames: [],
    manifest: {},
    assets: [],
    input: {} as Personalization,
  };
}
