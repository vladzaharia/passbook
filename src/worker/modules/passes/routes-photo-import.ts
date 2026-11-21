import {
  PhotoMatchRequestSchema,
  PhotoMatchResponseSchema,
} from '../../../shared/contracts/photo-import.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { authOf, orgIdOf, svc, tenantAuthorityOf } from './http.ts';
import { matchPhotoKeys } from './photo-import.ts';

/** Bulk photo import: the client crops each file and uploads it to `PUT /passes/{id}/member-photo`. */
export function registerPhotoImportRoutes(router: ReturnType<typeof createRouter>) {
  register(
    router,
    'passes',
    {
      method: 'post',
      path: '/photos/match',
      summary: 'Match photo file names to passes by External ID or serial',
      body: PhotoMatchRequestSchema,
      response: PhotoMatchResponseSchema,
    },
    async (c) => {
      const { orgId: asked, keys } = c.req.valid('json');
      const auth = authOf(c);
      const orgId = orgIdOf(auth, asked);
      const authority = await tenantAuthorityOf(svc(c), auth, orgId, 'passes:operate');
      return c.json({ matches: await matchPhotoKeys(svc(c).env.DB, orgId, authority.mode, keys) });
    },
  );
}
