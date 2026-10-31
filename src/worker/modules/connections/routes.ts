import { z } from 'zod';
import {
  ConnectionDetailSchema,
  ConnectionListQuerySchema,
  ConnectionListSchema,
  ConnectionSchema,
  ConnectorInfoSchema,
  ConnectorListSchema,
  CreateConnectionSchema,
  IdParamSchema,
  OkSchema,
  SyncNowResponseSchema,
  TestConnectionResponseSchema,
  UpdateConnectionSchema,
  WebhookAckSchema,
} from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import { createRouter, guard, stub } from '../../platform/openapi.ts';

/** /api/v1/connections */
export const connectionsRoutes = createRouter();
guard(connectionsRoutes, requireAdmin);
stub(connectionsRoutes, 'connections', {
  method: 'get',
  path: '/',
  summary: 'List connections',
  query: ConnectionListQuerySchema,
  response: ConnectionListSchema,
});
stub(connectionsRoutes, 'connections', {
  method: 'post',
  path: '/',
  summary: 'Create a connection',
  body: CreateConnectionSchema,
  status: 201,
  response: ConnectionSchema,
});
stub(connectionsRoutes, 'connections', {
  method: 'get',
  path: '/{id}',
  summary: 'Connection with runs and metrics',
  params: IdParamSchema,
  response: ConnectionDetailSchema,
});
stub(connectionsRoutes, 'connections', {
  method: 'patch',
  path: '/{id}',
  summary: 'Update a connection',
  params: IdParamSchema,
  body: UpdateConnectionSchema,
  response: ConnectionSchema,
});
stub(connectionsRoutes, 'connections', {
  method: 'delete',
  path: '/{id}',
  summary: 'Delete a connection',
  params: IdParamSchema,
  response: OkSchema,
});
stub(connectionsRoutes, 'connections', {
  method: 'post',
  path: '/{id}/test',
  summary: 'Test the connection',
  params: IdParamSchema,
  response: TestConnectionResponseSchema,
});
stub(connectionsRoutes, 'connections', {
  method: 'post',
  path: '/{id}/sync',
  summary: 'Sync now',
  params: IdParamSchema,
  status: 202,
  response: SyncNowResponseSchema,
});

/** /api/v1/connectors */
export const connectorsRoutes = createRouter();
guard(connectorsRoutes, requireAdmin);
stub(connectorsRoutes, 'connectors', {
  method: 'get',
  path: '/',
  summary: 'List connector types',
  response: ConnectorListSchema,
});
stub(connectorsRoutes, 'connectors', {
  method: 'get',
  path: '/{type}',
  summary: 'Get a connector type',
  params: z.object({ type: z.string() }),
  response: ConnectorInfoSchema,
});

/** /hooks/connections: signed inbound webhooks, no session. */
export const hooksRoutes = createRouter();
stub(hooksRoutes, 'connections', {
  method: 'post',
  path: '/connections/{id}',
  summary: 'Inbound webhook (signature verified)',
  params: IdParamSchema,
  status: 202,
  response: WebhookAckSchema,
});
