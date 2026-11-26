import { z } from 'zod';
import { IdSchema } from '../../../shared/contracts/common.ts';
import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import {
  DeleteSavedImportMappingQuerySchema,
  PutSavedImportMappingSchema,
  SavedImportMappingsQuerySchema,
  SavedImportMappingsResultSchema,
} from '../../../shared/contracts/pass-imports.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { assertSharedWrite } from '../orgs/shared-write.ts';
import { authOf, type C, orgIdOf, svc, tenantAuthorityOf } from './http.ts';
import { deleteSaved, putSaved, readMappings } from './import-mappings.ts';

type Router = ReturnType<typeof createRouter>;
const TAG = 'pass-imports';

export async function authorityFor(c: C, orgId: string | undefined, capability: OrgCapability) {
  const auth = authOf(c);
  return tenantAuthorityOf(svc(c), auth, orgIdOf(auth, orgId), capability);
}

/** Named column mappings: registered before `/{id}` so "mappings" is not read as an id. */
export function registerImportMappings(router: Router): void {
  register(
    router,
    TAG,
    {
      method: 'get',
      path: '/mappings',
      summary: "A template's saved column mappings",
      query: SavedImportMappingsQuerySchema,
      response: SavedImportMappingsResultSchema,
    },
    async (c) => {
      const q = c.req.valid('query');
      const authority = await authorityFor(c, q.orgId, 'passes:read');
      return c.json({ saved: (await readMappings(svc(c), authority.orgId, q.templateId)).saved });
    },
  );

  register(
    router,
    TAG,
    {
      method: 'put',
      path: '/mappings',
      summary: 'Save a named column mapping for a template; the same name replaces it',
      query: z.object({ orgId: IdSchema.optional() }),
      body: PutSavedImportMappingSchema,
      response: SavedImportMappingsResultSchema,
    },
    async (c) => {
      const { templateId, ...mapping } = c.req.valid('json');
      const authority = await authorityFor(c, c.req.valid('query').orgId, 'passes:operate');
      await assertSharedWrite(svc(c), authority, authority.orgId, 'saved mappings');
      return c.json({ saved: await putSaved(svc(c), authority, templateId, mapping) });
    },
  );

  register(
    router,
    TAG,
    {
      method: 'delete',
      path: '/mappings',
      summary: 'Delete a saved column mapping by name',
      query: DeleteSavedImportMappingQuerySchema,
      response: SavedImportMappingsResultSchema,
    },
    async (c) => {
      const q = c.req.valid('query');
      const authority = await authorityFor(c, q.orgId, 'passes:operate');
      await assertSharedWrite(svc(c), authority, authority.orgId, 'saved mappings');
      return c.json({ saved: await deleteSaved(svc(c), authority, q.templateId, q.name) });
    },
  );
}
