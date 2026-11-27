import {
  CursorQuerySchema,
  IdParamSchema,
  IncidentListSchema,
  OpenIncidentSchema,
  PublicIncidentSchema,
  StatusQuerySchema,
  StatusResponseSchema,
  WorkflowRunListSchema,
} from '../../../shared/contracts/index.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requestActor } from '../audit/http.ts';
import { listIncidents, openIncident, resolveIncident } from './incidents.ts';
import { getStatus, listWorkflowRuns } from './service.ts';

export const statusRoutes = createRouter();

register(
  statusRoutes,
  'status',
  {
    method: 'get',
    auth: { platform: 'platform:status' },
    path: '/',
    summary: 'Component health',
    query: StatusQuerySchema,
    response: StatusResponseSchema,
  },
  async (c) => {
    const { fresh } = c.req.valid('query');
    return c.json(await getStatus(serviceContext(c), { fresh: fresh === '1' }));
  },
);
register(
  statusRoutes,
  'status',
  {
    method: 'get',
    auth: { platform: 'platform:status' },
    path: '/workflows',
    summary: 'Recent workflow runs',
    query: CursorQuerySchema,
    response: WorkflowRunListSchema,
  },
  async (c) => c.json(await listWorkflowRuns(serviceContext(c))),
);
register(
  statusRoutes,
  'status',
  {
    method: 'get',
    auth: { platform: 'platform:status' },
    path: '/incidents',
    summary: 'Incident notes on the public status page',
    query: CursorQuerySchema,
    response: IncidentListSchema,
  },
  async (c) => c.json(await listIncidents(serviceContext(c))),
);
register(
  statusRoutes,
  'status',
  {
    method: 'post',
    auth: { platform: 'platform:status' },
    path: '/incidents',
    summary: 'Open an incident note on the public status page',
    body: OpenIncidentSchema,
    status: 201,
    response: PublicIncidentSchema,
  },
  async (c) =>
    c.json(await openIncident(serviceContext(c), requestActor(c), c.req.valid('json')), 201),
);
register(
  statusRoutes,
  'status',
  {
    method: 'post',
    auth: { platform: 'platform:status' },
    path: '/incidents/{id}/resolve',
    summary: 'Resolve an incident note',
    params: IdParamSchema,
    response: PublicIncidentSchema,
  },
  async (c) =>
    c.json(await resolveIncident(serviceContext(c), requestActor(c), c.req.valid('param').id)),
);
