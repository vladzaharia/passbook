import type { TemplateRegistry } from '../../../passkit/template/registry.ts';
import type { AppEnv } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';

/** Personalization files are dropped from the personalized pass (catalog §16). */
const isPersonalizationFile = (name: string) =>
  /(^|\/)personalization(Logo(@[23]x)?\.png|\.json)$/.test(name);

function withoutPersonalization(registry: TemplateRegistry): TemplateRegistry {
  return {
    list: (query) => registry.list(query),
    async resolve(id, version) {
      const template = await registry.resolve(id, version);
      return { ...template, assets: template.assets.filter((a) => !isPersonalizationFile(a.name)) };
    },
    openAsset: (template, name) => registry.openAsset(template, name),
  };
}

/**
 * A context whose pass builds omit personalization.json and the logo. Deps are keyed by env
 * object, so a derived env carries its own registry without touching the shared one.
 * Passes that are already personalized must be published through this context.
 */
export function withoutPersonalizationFiles(ctx: ServiceContext): ServiceContext {
  const env = Object.create(ctx.env) as AppEnv;
  const base = depsOf(ctx.env);
  overrideDeps(env, { ...base, registry: withoutPersonalization(base.registry) });
  return { ...ctx, env };
}
