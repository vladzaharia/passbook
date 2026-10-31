import { bakedTemplates } from '../../../generated/baked-templates.ts';
import type { TemplateRegistry } from '../../../passkit/template/registry.ts';
import type { AppEnv } from '../../platform/env.ts';
import { NotFoundError } from '../../platform/errors.ts';

/**
 * Composite registry (baked + uploaded D1/R2). Foundation returns an empty registry; the templates
 * module replaces this with the real implementation and keeps this signature.
 */
export function createTemplateRegistry(_env: AppEnv): TemplateRegistry {
  void bakedTemplates;
  return {
    list: async () => [],
    resolve: async (id) => {
      throw new NotFoundError(`Template ${id} not found.`, 'TEMPLATE_NOT_FOUND');
    },
    openAsset: async (_template, name) => {
      throw new NotFoundError(`Asset ${name} not found.`, 'ASSET_NOT_FOUND');
    },
  };
}
