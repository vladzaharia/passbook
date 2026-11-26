import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { CursorQuerySchema, IdSchema, pageOf } from '../../../shared/contracts/common.ts';
import {
  CreateTagEnrollmentSchema,
  TagEnrollmentSchema,
  TagScannerQuerySchema,
  TagScannerSchema,
} from '../../../shared/contracts/nfc-tag-enrollments.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { listEnrollScanners } from './enrollment-scanners.ts';
import { cancelEnrollment, getEnrollment, requestEnrollment } from './enrollments.ts';
import { passFacts } from './repo-tag-bindings.ts';
import { actingIn, CONSOLE, orgNotFound, passNotFound } from './route-access.ts';
import { tagAuthorityOf } from './tags-admin.ts';

const TAG = 'nfc-tags';
const PassParam = z.object({ passId: IdSchema });
const EnrollmentParam = z.object({ passId: IdSchema, id: IdSchema });

/** Remote enrollment: `/api/v1/nfc/scanners` and `/passes/{passId}/enrollments`. Console sessions only. */
export function registerEnrollmentRoutes(nfcRoutes: OpenAPIHono<AppBindings>): void {
  register(
    nfcRoutes,
    TAG,
    {
      method: 'get',
      path: '/scanners',
      summary: 'Scanners that can take a tag request',
      auth: CONSOLE,
      query: TagScannerQuerySchema.extend(CursorQuerySchema.shape),
      response: pageOf(TagScannerSchema),
    },
    async (c) => {
      const { ctx, authority } = await actingIn(
        c,
        c.req.valid('query').orgId,
        'passes:operate',
        orgNotFound,
      );
      return c.json({
        items: await listEnrollScanners(ctx, tagAuthorityOf(authority)),
        nextCursor: null,
      });
    },
  );

  async function onPass(c: Parameters<typeof actingIn>[0], passId: string, write: boolean) {
    const pass = await passFacts(serviceContext(c).env.DB, passId);
    if (!pass) throw passNotFound();
    const acting = await actingIn(
      c,
      pass.orgId,
      write ? 'passes:operate' : 'passes:read',
      passNotFound,
    );
    if (pass.mode !== acting.authority.mode || pass.deletedAt !== null) throw passNotFound();
    return acting;
  }

  register(
    nfcRoutes,
    TAG,
    {
      method: 'post',
      path: '/passes/{passId}/enrollments',
      summary: 'Ask a scanner to read a tag for a pass',
      auth: { ...CONSOLE, feature: { key: 'nfc', atLeast: 'basic' } },
      params: PassParam,
      body: CreateTagEnrollmentSchema,
      response: TagEnrollmentSchema,
    },
    async (c) => {
      const { passId } = c.req.valid('param');
      const { ctx, authority } = await onPass(c, passId, true);
      return c.json(
        await requestEnrollment(ctx, tagAuthorityOf(authority), passId, c.req.valid('json')),
      );
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'get',
      path: '/passes/{passId}/enrollments/{id}',
      summary: 'A tag request',
      auth: CONSOLE,
      params: EnrollmentParam,
      response: TagEnrollmentSchema,
    },
    async (c) => {
      const { passId, id } = c.req.valid('param');
      const { ctx, authority } = await onPass(c, passId, false);
      c.header('cache-control', 'no-store');
      return c.json(await getEnrollment(ctx, authority.orgId, authority.mode, passId, id));
    },
  );

  register(
    nfcRoutes,
    TAG,
    {
      method: 'delete',
      path: '/passes/{passId}/enrollments/{id}',
      summary: 'Cancel a tag request',
      auth: CONSOLE,
      params: EnrollmentParam,
      response: TagEnrollmentSchema,
    },
    async (c) => {
      const { passId, id } = c.req.valid('param');
      const { ctx, authority } = await onPass(c, passId, true);
      return c.json(await cancelEnrollment(ctx, tagAuthorityOf(authority), passId, id));
    },
  );
}
