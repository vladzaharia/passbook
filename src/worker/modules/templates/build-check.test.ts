import { beforeAll, describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/index.ts';
import { planPass } from '../../../passkit/build.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { AssetEntry, PassJson } from '../../../passkit/types.ts';
import type { AppEnv } from '../../platform/env.ts';
import { behaviors, previewPass } from './build-check.ts';
import { generatedSource } from './sync.ts';

let env: AppEnv;

beforeAll(async () => {
  env = await makeEnv();
});

function resolved(slug: string): ResolvedTemplate {
  const t = generatedSource.templates.find((x) => x.slug === slug);
  if (!t) throw new Error(`no baked template ${slug}`);
  return {
    id: t.id,
    version: t.version,
    orgId: null,
    origin: 'baked',
    manifest: t.manifest,
    passJson: t.passJson as PassJson,
    assets: t.assets as AssetEntry[],
    styles: t.styles,
  };
}

describe('previewPass', () => {
  it('applies input defaults and behaviors like a real build', () => {
    const template = resolved('henrys-copper');
    const input = { memberName: 'Sam Rivera', memberId: 'M-1', membership: 'All-Inclusive' };
    const now = new Date(1_700_000_000_000);
    const preview = previewPass(env, template, input, 'Henry’s', now);
    const planned = planPass({
      template,
      registry: {
        list: async () => [],
        resolve: async () => template,
        openAsset: async () => null as never,
      },
      input,
      server: {
        serial: 'preview',
        authToken: 'x'.repeat(32),
        webServiceURL: 'https://wallet.test/wallet',
        organizationName: 'Henry’s',
        identity: {
          passTypeIdentifier: env.PLATFORM_PASS_TYPE_ID,
          teamIdentifier: env.PLATFORM_TEAM_ID,
        },
      },
      signing: undefined as never,
      behaviors,
      now,
    });
    expect(preview.passJson.locations?.length ?? 0).toBeGreaterThan(0);
    expect(preview.passJson.locations).toEqual(planned.passJson.locations);
    expect(preview.passJson.featuredActions).toEqual(planned.passJson.featuredActions);
    expect(preview.passJson.authenticationToken).toBeUndefined();
    expect(preview.issues).toEqual(planned.report.issues);
  });
});
