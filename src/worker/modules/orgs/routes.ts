import type { Context } from 'hono';
import { z } from 'zod';
import {
  BrandingSlotParamSchema,
  CreateOrgSchema,
  IdParamSchema,
  IdSchema,
  OkSchema,
  OrgListQuerySchema,
  OrgListSchema,
  OrgSchema,
  OrgStatusSchema,
  OrgSummarySchema,
  UpdateOrgSchema,
  UploadBrandingImageSchema,
} from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requestActor, valid } from '../audit/http.ts';
import { deleteBrandingImage, getBrandingImage, putBrandingImage } from './branding.ts';
import { createOrg, deleteOrg, getOrg, listOrgs, setOrgStatus, updateOrg } from './service.ts';

export const orgsRoutes = createRouter();
guard(orgsRoutes, requireAdmin);
// Two base64 PNGs of at most 200 KB each, plus JSON overhead.
orgsRoutes.use('*', limitBody(1024 * 1024));

type Ctx = Context<AppBindings>;
const idOf = (c: Ctx) => valid<{ id: string }>(c, 'param').id;
const slotOf = (c: Ctx) => valid<z.infer<typeof BrandingSlotParamSchema>>(c, 'param').slot;

register(
  orgsRoutes,
  'orgs',
  {
    method: 'get',
    path: '/',
    summary: 'List organizations',
    query: OrgListQuerySchema,
    response: OrgListSchema,
  },
  async (c: Ctx) => c.json(await listOrgs(serviceContext(c), valid(c, 'query'))),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'post',
    path: '/',
    summary: 'Create an organization',
    body: CreateOrgSchema,
    status: 201,
    response: OrgSchema,
  },
  async (c: Ctx) =>
    c.json(
      await createOrg(
        serviceContext(c),
        requestActor(c),
        valid<z.infer<typeof CreateOrgSchema>>(c, 'json'),
      ),
      201,
    ),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'get',
    path: '/{id}',
    summary: 'Get an organization',
    params: IdParamSchema,
    response: OrgSummarySchema,
  },
  async (c: Ctx) => c.json(await getOrg(serviceContext(c), idOf(c))),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'patch',
    path: '/{id}',
    summary: 'Update an organization',
    params: IdParamSchema,
    body: UpdateOrgSchema,
    response: OrgSchema,
  },
  async (c: Ctx) =>
    c.json(
      await updateOrg(
        serviceContext(c),
        requestActor(c),
        idOf(c),
        valid<z.infer<typeof UpdateOrgSchema>>(c, 'json'),
      ),
    ),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'post',
    path: '/{id}/status',
    summary: 'Suspend or reactivate an organization',
    params: IdParamSchema,
    body: OrgStatusSchema,
    response: OrgSchema,
  },
  async (c: Ctx) =>
    c.json(
      await setOrgStatus(
        serviceContext(c),
        requestActor(c),
        idOf(c),
        valid<z.infer<typeof OrgStatusSchema>>(c, 'json').status,
      ),
    ),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'put',
    path: '/{id}/branding/{slot}',
    summary: 'Upload the pass logo or icon (@3x PNG; @2x derived)',
    params: BrandingSlotParamSchema,
    body: UploadBrandingImageSchema,
    response: OrgSchema,
  },
  async (c: Ctx) =>
    c.json(
      await putBrandingImage(
        serviceContext(c),
        requestActor(c),
        idOf(c),
        slotOf(c),
        valid<z.infer<typeof UploadBrandingImageSchema>>(c, 'json'),
      ),
    ),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'delete',
    path: '/{id}/branding/{slot}',
    summary: 'Remove the pass logo or icon',
    params: BrandingSlotParamSchema,
    response: OrgSchema,
  },
  async (c: Ctx) =>
    c.json(await deleteBrandingImage(serviceContext(c), requestActor(c), idOf(c), slotOf(c))),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'get',
    path: '/{id}/branding/{slot}/{scale}',
    summary: 'Download the pass logo or icon',
    params: z.object({
      id: IdSchema,
      slot: BrandingSlotParamSchema.shape.slot,
      scale: z.enum(['2x', '3x']),
    }),
  },
  async (c: Ctx) => {
    const p = valid<{ id: string; slot: 'logo' | 'icon'; scale: '2x' | '3x' }>(c, 'param');
    const bytes = await getBrandingImage(serviceContext(c), p.id, p.slot, p.scale === '3x' ? 3 : 2);
    return c.body(bytes, 200, {
      'content-type': 'image/png',
      'cache-control': 'private, max-age=60',
      'x-content-type-options': 'nosniff',
    });
  },
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'delete',
    path: '/{id}',
    summary: 'Delete an organization',
    params: IdParamSchema,
    response: OkSchema,
  },
  async (c: Ctx) => {
    await deleteOrg(serviceContext(c), requestActor(c), idOf(c));
    return c.json({ ok: true });
  },
);
