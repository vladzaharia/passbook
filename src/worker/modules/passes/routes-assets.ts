import { bodyLimit } from 'hono/body-limit';
import {
  IdParamSchema,
  OkSchema,
  PassAssetListSchema,
  PassAssetParamSchema,
  PassAssetSchema,
} from '../../../shared/contracts/index.ts';
import { PayloadTooLargeError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { deletePassAsset, listPassAssets, putPassAsset } from './asset-service.ts';
import { MAX_ASSET_BYTES } from './assets.ts';
import { actorFor, passScopeOf, svc } from './http.ts';

/** Per-pass image overrides. */
export function registerAssetRoutes(passesRoutes: ReturnType<typeof createRouter>): void {
  passesRoutes.use(
    '/:id/assets/:name',
    bodyLimit({
      maxSize: MAX_ASSET_BYTES,
      onError: () => {
        throw new PayloadTooLargeError('The image must be 1 MB or smaller.', 'ASSET_SIZE');
      },
    }),
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'get',
      path: '/{id}/assets',
      summary: 'Per-pass image overrides',
      params: IdParamSchema,
      response: PassAssetListSchema,
    },
    async (c) => c.json(await listPassAssets(svc(c), c.req.valid('param').id, passScopeOf(c))),
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'put',
      path: '/{id}/assets/{name}',
      summary: 'Upload an image override (PNG body)',
      params: PassAssetParamSchema,
      response: PassAssetSchema,
    },
    async (c) => {
      const p = c.req.valid('param');
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      return c.json(await putPassAsset(svc(c), actorFor(c), p.id, p.name, bytes, passScopeOf(c)));
    },
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'delete',
      path: '/{id}/assets/{name}',
      summary: 'Remove an image override',
      params: PassAssetParamSchema,
      response: OkSchema,
    },
    async (c) => {
      const p = c.req.valid('param');
      await deletePassAsset(svc(c), actorFor(c), p.id, p.name, passScopeOf(c));
      return c.json({ ok: true });
    },
  );
}
