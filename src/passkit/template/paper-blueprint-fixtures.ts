/** Test helper: a blueprint's sample pass, planned without signing, ready for `paperContent`. */
import { planPass } from '../build.ts';
import { FIXTURE_IDENTITY } from '../testing/fixture-identity.ts';
import type { PassJson, Personalization, TemplateManifest } from '../types.ts';
import { bakedBehaviors, loadBaked } from './baked-fixtures.ts';

export const SCAN_CODE = 'SCAN-XYZ-0001';

export async function blueprintPass(
  slug: string,
  over: Personalization = {},
  options: { strips?: boolean } = {},
): Promise<{ passJson: PassJson; manifest: TemplateManifest; personalization: Personalization }> {
  const { template, registry } = await loadBaked(slug, { strips: options.strips ?? false });
  const personalization = { ...template.manifest.sample, ...over };
  const { passJson } = planPass({
    template,
    registry,
    input: personalization,
    server: {
      serial: 'SER-0001',
      authToken: 'a'.repeat(32),
      webServiceURL: 'https://wallet.example/wallet',
      organizationName: 'Org',
      identity: FIXTURE_IDENTITY,
      scanCode: SCAN_CODE,
    },
    signing: {} as never,
    behaviors: bakedBehaviors,
    now: new Date('2030-01-01T00:00:00Z'),
  });
  return { passJson, manifest: template.manifest, personalization };
}
