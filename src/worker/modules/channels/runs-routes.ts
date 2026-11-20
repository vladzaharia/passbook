import {
  ChannelApplyRunsResponseSchema,
  ChannelsQuerySchema,
  IdParamSchema,
} from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { authOf, svc } from '../passes/http.ts';
import type { TemplateRef } from './repo.ts';
import { listRuns } from './repo-runs.ts';

type Router = ReturnType<typeof createRouter>;
type Ctx = Parameters<typeof authOf>[0];

/** GET /api/v1/templates/{id}/channels/runs: how the template's saves are being applied. */
export function registerChannelRunRoutes(
  templatesRoutes: Router,
  templateFor: (
    c: Ctx,
    capability: 'templates:read',
    requestedOrg: string | undefined,
  ) => Promise<{ template: TemplateRef }>,
): void {
  register(
    templatesRoutes,
    'templates',
    {
      method: 'get',
      path: '/{id}/channels/runs',
      summary: 'The latest runs that applied saved channel changes to passes, in this mode',
      params: IdParamSchema,
      query: ChannelsQuerySchema,
      response: ChannelApplyRunsResponseSchema,
    },
    async (c) => {
      const { template } = await templateFor(c, 'templates:read', c.req.valid('query').orgId);
      const runs = await listRuns(svc(c).env.DB, template.orgId, modeOf(authOf(c)), template.id);
      return c.json(
        runs.map((r) => ({
          id: r.id,
          state: r.state,
          dueAt: r.dueAt,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          counts: { ...r.counts },
          errorCode: r.errorCode,
        })),
      );
    },
  );
}
