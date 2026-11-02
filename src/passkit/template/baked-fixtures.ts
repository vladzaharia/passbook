// Test helper: loads templates/<slug> as a ResolvedTemplate with a registry that serves its files.
import { join } from 'node:path';
import expiryFromInput from '../behaviors/expiry-from-input/index.ts';
import { createBehaviorRegistry } from '../behaviors/registry.ts';
import relevanceWindow from '../behaviors/relevance-window/index.ts';
import venueLocations from '../behaviors/venue-locations/index.ts';
import { buildPass } from '../build.ts';
import { FIXTURE_IDENTITY } from '../testing/fixture-identity.ts';
import type { BehaviorPlugin, PassStyle, Personalization, SigningMaterial } from '../types.ts';
import { PASS_STYLES } from '../types.ts';
import { listTemplateDirs, readTemplateDir } from './load-dir.ts';
import type { TemplatePackage } from './package.ts';
import type { ResolvedTemplate, TemplateRegistry } from './registry.ts';

export const TEMPLATES_ROOT = join(import.meta.dirname, '../../../templates');
export const bakedBehaviors = createBehaviorRegistry([
  venueLocations as BehaviorPlugin,
  expiryFromInput as BehaviorPlugin,
  relevanceWindow as BehaviorPlugin,
]);

export function bakedSlugs(): string[] {
  return listTemplateDirs(TEMPLATES_ROOT);
}

export async function loadBaked(
  slug: string,
): Promise<{ template: ResolvedTemplate; registry: TemplateRegistry; pkg: TemplatePackage }> {
  const pkg = await readTemplateDir(join(TEMPLATES_ROOT, slug));
  const template: ResolvedTemplate = {
    id: slug,
    version: 'test',
    orgId: null,
    origin: 'baked',
    manifest: pkg.manifest,
    passJson: pkg.passJson,
    assets: pkg.assets,
    styles: PASS_STYLES.filter((s): s is PassStyle => typeof pkg.passJson[s] === 'object'),
  };
  const registry: TemplateRegistry = {
    async list() {
      return [];
    },
    async resolve() {
      return template;
    },
    async openAsset(_t, name) {
      const bytes = pkg.bytes[name];
      if (!bytes) throw new Error(`Asset ${name} not found`);
      return new Response(bytes as BodyInit).body as ReadableStream<Uint8Array>;
    },
  };
  return { template, registry, pkg };
}

/** Stable pretty JSON with sorted keys, for golden files. */
export function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, sort(x)]),
      );
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

export async function buildBaked(slug: string, signing: SigningMaterial, input?: Personalization) {
  const { template, registry } = await loadBaked(slug);
  return buildPass({
    template,
    registry,
    input: input ?? template.manifest.sample,
    server: {
      serial: 'SNAPSHOT-SERIAL',
      authToken: 'a'.repeat(32),
      webServiceURL: 'https://wallet.example/wallet',
      organizationName: template.manifest.org?.name ?? 'PassBook',
      identity: FIXTURE_IDENTITY,
    },
    signing,
    behaviors: bakedBehaviors,
    now: FIXED_NOW,
  });
}

/** Fixed clock inside the fixture certificate's validity window is not possible; see tests. */
export let FIXED_NOW: Date | undefined;
export function freezeNow(): Date {
  FIXED_NOW = new Date();
  return FIXED_NOW;
}
