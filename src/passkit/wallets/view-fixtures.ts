/** Test helper: the wallet view of a baked template's sample. */
import { planPass } from '../build.ts';
import { bakedBehaviors, loadBaked } from '../template/baked-fixtures.ts';
import { FIXTURE_IDENTITY } from '../testing/fixture-identity.ts';
import type { SigningMaterial, TemplateManifest } from '../types.ts';
import type { WalletPassView } from './types.ts';
import { resolveWalletView, type ViewContext } from './view.ts';

export const NOW = new Date('2026-11-17T10:00:00Z');

export async function viewOf(
  slug: string,
  options: { wallets?: unknown; ctx?: Partial<ViewContext> } = {},
): Promise<WalletPassView> {
  const { template, registry } = await loadBaked(slug);
  const plan = planPass({
    template,
    registry,
    input: template.manifest.sample,
    server: {
      serial: 'SERIAL',
      authToken: 'a'.repeat(32),
      webServiceURL: 'https://wallet.example/wallet',
      organizationName: template.manifest.org?.name ?? 'PassBook',
      identity: FIXTURE_IDENTITY,
      scanCode: 'SNAPSHOT-SCAN-CODE',
    },
    signing: {} as SigningMaterial,
    behaviors: bakedBehaviors,
    now: NOW,
  });
  const manifest = (
    options.wallets === undefined
      ? template.manifest
      : { ...template.manifest, wallets: options.wallets }
  ) as TemplateManifest;
  return resolveWalletView(plan, manifest, {
    now: NOW,
    timeZone: 'UTC',
    locales: ['en'],
    input: template.manifest.sample,
    assets: template.assets,
    ...options.ctx,
  });
}
