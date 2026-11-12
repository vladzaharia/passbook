import {
  MemberPhotoSchema,
  PutMemberPhotoSchema,
  UpdateMemberPhotoSchema,
} from '../../../shared/contracts/check-in.ts';
import { IdParamSchema } from '../../../shared/contracts/common.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { actorFor, authOf, passScopeOf, svc } from './http.ts';
import {
  deleteMemberPhoto,
  getMemberPhoto,
  putMemberPhoto,
  readMemberPhoto,
  updateMemberPhoto,
} from './member-photo.ts';
import { tenantPassForRead, tenantPassForWrite } from './pass-access.ts';

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
    async (c) => {
      const ctx = svc(c);
      const id = c.req.valid('param').id;
      const { scope } = await tenantPassForRead(ctx, authOf(c), id, passScopeOf(c));
      return c.json(await getMemberPhoto(ctx, id, scope));
    },
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
    async (c) => {
      const ctx = svc(c);
      const id = c.req.valid('param').id;
      const { scope } = await tenantPassForRead(ctx, authOf(c), id, passScopeOf(c));
      return readMemberPhoto(ctx, id, scope);
    },
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
    async (c) => {
      const ctx = svc(c);
      const id = c.req.valid('param').id;
      const { scope, authority } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
      return c.json(
        await putMemberPhoto(ctx, actorFor(c), id, c.req.valid('json'), scope, authority),
      );
    },
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
    async (c) => {
      const ctx = svc(c);
      const id = c.req.valid('param').id;
      const { scope, authority } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
      return c.json(
        await updateMemberPhoto(
          ctx,
          actorFor(c),
          id,
          c.req.valid('json').includeInPass,
          scope,
          authority,
        ),
      );
    },
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
    async (c) => {
      const ctx = svc(c);
      const id = c.req.valid('param').id;
      const { scope, authority } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
      return c.json(await deleteMemberPhoto(ctx, actorFor(c), id, scope, authority));
    },
  );
}
