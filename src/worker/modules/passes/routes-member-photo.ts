import {
  MemberPhotoSchema,
  PutMemberPhotoSchema,
  UpdateMemberPhotoSchema,
} from '../../../shared/contracts/check-in.ts';
import { IdParamSchema } from '../../../shared/contracts/common.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { actorFor, passScopeOf, svc } from './http.ts';
import {
  deleteMemberPhoto,
  getMemberPhoto,
  putMemberPhoto,
  readMemberPhoto,
  updateMemberPhoto,
} from './member-photo.ts';

export function registerMemberPhotoRoutes(router: ReturnType<typeof createRouter>) {
  router.use('/:id/member-photo', limitBody(1_410_000));
  register(
    router,
    'passes',
    {
      method: 'get',
      path: '/{id}/member-photo',
      summary: 'Member photo settings',
      params: IdParamSchema,
      response: MemberPhotoSchema,
    },
    async (c) => c.json(await getMemberPhoto(svc(c), c.req.valid('param').id, passScopeOf(c))),
  );
  register(
    router,
    'passes',
    {
      method: 'get',
      path: '/{id}/member-photo/image',
      summary: 'Private member photo',
      params: IdParamSchema,
    },
    async (c) => readMemberPhoto(svc(c), c.req.valid('param').id, passScopeOf(c)),
  );
  register(
    router,
    'passes',
    {
      method: 'put',
      path: '/{id}/member-photo',
      summary: 'Upload a member photo',
      params: IdParamSchema,
      body: PutMemberPhotoSchema,
      response: MemberPhotoSchema,
    },
    async (c) =>
      c.json(
        await putMemberPhoto(
          svc(c),
          actorFor(c),
          c.req.valid('param').id,
          c.req.valid('json'),
          passScopeOf(c),
        ),
      ),
  );
  register(
    router,
    'passes',
    {
      method: 'patch',
      path: '/{id}/member-photo',
      summary: 'Set Wallet photo inclusion',
      params: IdParamSchema,
      body: UpdateMemberPhotoSchema,
      response: MemberPhotoSchema,
    },
    async (c) =>
      c.json(
        await updateMemberPhoto(
          svc(c),
          actorFor(c),
          c.req.valid('param').id,
          c.req.valid('json').includeInPass,
          passScopeOf(c),
        ),
      ),
  );
  register(
    router,
    'passes',
    {
      method: 'delete',
      path: '/{id}/member-photo',
      summary: 'Remove a member photo',
      params: IdParamSchema,
      response: MemberPhotoSchema,
    },
    async (c) =>
      c.json(await deleteMemberPhoto(svc(c), actorFor(c), c.req.valid('param').id, passScopeOf(c))),
  );
}
