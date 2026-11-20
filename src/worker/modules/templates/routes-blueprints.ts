import {
  IdParamSchema,
  SaveVersionResponseSchema,
  TemplateDetailSchema,
  UseBlueprintCheckSchema,
  UseBlueprintSchema,
} from '../../../shared/contracts/index.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { checkBlueprintDraft, useBlueprint } from './use-blueprint.ts';
import { VERSION_BODY_LIMIT } from './version-files.ts';

type Router = ReturnType<typeof createRouter>;

/** POST /{id}/use and its dry run: make an org's template from a blueprint. */
export function registerBlueprints(router: Router): void {
  // The designer's draft carries new images as base64, like a version save.
  router.use('/:id/use', limitBody(VERSION_BODY_LIMIT));
  router.use('/:id/use/check', limitBody(VERSION_BODY_LIMIT));
  register(
    router,
    'templates',
    {
      method: 'post',
      path: '/{id}/use',
      summary: 'Make a template in an organization from a blueprint',
      auth: { scope: 'templates:write', capability: 'templates:author' },
      params: IdParamSchema,
      body: UseBlueprintSchema,
      status: 201,
      response: TemplateDetailSchema,
    },
    async (c) =>
      c.json(
        await useBlueprint(
          serviceContext(c),
          c.var.auth,
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
        201,
      ),
  );
  register(
    router,
    'templates',
    {
      method: 'post',
      path: '/{id}/use/check',
      summary: "Check a designer draft made from a blueprint as the organization's template",
      params: IdParamSchema,
      body: UseBlueprintCheckSchema,
      response: SaveVersionResponseSchema,
    },
    async (c) =>
      c.json(
        await checkBlueprintDraft(
          serviceContext(c),
          c.var.auth,
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
      ),
  );
}
