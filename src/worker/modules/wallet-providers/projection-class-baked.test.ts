// Every baked blueprint passes the Google class rule, so a starter can issue on Google.
import { describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/index.ts';
import type { Personalization } from '../../../passkit/types.ts';
import { googleCompiler } from '../../../passkit/wallets/google/compilers.ts';
import { resolveWalletView } from '../../../passkit/wallets/view.ts';
import { previewPlan } from '../templates/build-check.ts';
import { createTemplateRegistry } from '../templates/registry.ts';
import { generatedSource } from '../templates/sync.ts';
import { classProbes, withClassRule } from './projection-class-rule.ts';

const blueprints = generatedSource.templates.filter((t) => t.blueprint);

describe('baked blueprints and the Google class rule', () => {
  it('has blueprints to check', () => {
    expect(blueprints.length).toBeGreaterThan(10);
  });

  it.each(blueprints.map((t) => t.slug))('%s has no CLASS_FIELDS_VARY block', async (slug) => {
    const env = await makeEnv();
    const registry = createTemplateRegistry(env);
    const template = await registry.resolve(`baked:${slug}`);
    const now = new Date('2026-11-01T00:00:00Z');
    const viewOf = (input: Personalization) =>
      resolveWalletView(
        previewPlan(env, template, input, template.passJson.organizationName, now),
        template.manifest,
        {
          now,
          timeZone: 'UTC',
          locales: [],
          input,
          assets: template.assets,
          assetUrl: (name) => `https://assets.test/${name}`,
        },
      );
    const sample = template.manifest.sample as Personalization;
    const compiler = withClassRule(
      googleCompiler,
      classProbes(
        template.manifest.inputs,
        sample,
        template.manifest.wallets?.google?.classKey,
        viewOf,
      ),
    );
    const result = compiler.compile(viewOf(sample), { now, omit: [] });
    expect(result.blocked).toBeUndefined();
  });
});
