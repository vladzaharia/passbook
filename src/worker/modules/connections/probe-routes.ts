import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { IdParamSchema } from '../../../shared/contracts/common.ts';
import {
  ProbeConfigSchema,
  ProbeConnectionSchema,
  ProbeResultSchema,
} from '../../../shared/contracts/connection-probe.ts';
import { modeOf } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { actorOf } from '../../platform/context.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authorizeConnection, authorizeStoredConnection } from './access.ts';
import { probeStored, probeUnsaved } from './probe.ts';
import { requireConnection } from './service-shared.ts';

type C = Context<AppBindings>;

/** The probe reads the answer of a live host with live credentials: there is no Test environment for it. */
function assertLive(c: C): void {
  if (modeOf(c.var.auth) !== 'live')
    throw new NotFoundError('Connection not found.', 'CONNECTION_NOT_FOUND');
}

/**
 * `POST /probe` and `POST /{id}/probe` of the connections router: fetch one sample page or record and get back
 * what the explorer shows. Scope `connections:write`, session capability `integrations:manage`; paced per org
 * and per caller (probe.ts).
 */
export function registerConnectionProbeRoutes(router: OpenAPIHono<AppBindings>): void {
  register(
    router,
    'connections',
    {
      method: 'post',
      path: '/probe',
      summary: 'Probe an unsaved REST configuration',
      body: ProbeConfigSchema,
      response: ProbeResultSchema,
    },
    async (c) => {
      assertLive(c);
      const ctx = serviceContext(c);
      const input = c.req.valid('json');
      const authority = await authorizeConnection(
        ctx,
        c.var.auth,
        input.orgId,
        'integrations:manage',
      );
      return c.json(await probeUnsaved(ctx, actorOf(c.var.auth), input, authority));
    },
  );
  register(
    router,
    'connections',
    {
      method: 'post',
      path: '/{id}/probe',
      summary: 'Probe a saved REST connection',
      params: IdParamSchema,
      body: ProbeConnectionSchema,
      response: ProbeResultSchema,
    },
    async (c) => {
      assertLive(c);
      const ctx = serviceContext(c);
      const id = c.req.valid('param').id;
      const conn = await requireConnection(ctx, id);
      const authority = await authorizeStoredConnection(
        ctx,
        c.var.auth,
        conn.orgId,
        'integrations:manage',
      );
      return c.json(
        await probeStored(ctx, actorOf(c.var.auth), id, c.req.valid('json'), authority),
      );
    },
  );
}
