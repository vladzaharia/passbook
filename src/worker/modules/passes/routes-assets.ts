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
import { actorFor, authOf, passScopeOf, svc } from './http.ts';
import { tenantPassForRead, tenantPassForWrite } from './pass-access.ts';

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
    async (c) => {
      const ctx = svc(c);
      const id = c.req.valid('param').id;
      const { scope } = await tenantPassForRead(ctx, authOf(c), id, passScopeOf(c));
      return c.json(await listPassAssets(ctx, id, scope));
    },
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
      const ctx = svc(c);
      const p = c.req.valid('param');
      const { authority, scope } = await tenantPassForWrite(ctx, authOf(c), p.id, passScopeOf(c));
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      return c.json(
        await putPassAsset(ctx, actorFor(c), p.id, p.name, bytes, scope, undefined, authority),
      );
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
      const ctx = svc(c);
      const p = c.req.valid('param');
      const { authority, scope } = await tenantPassForWrite(ctx, authOf(c), p.id, passScopeOf(c));
      await deletePassAsset(ctx, actorFor(c), p.id, p.name, scope, authority);
      return c.json({ ok: true });
    },
  );
}
