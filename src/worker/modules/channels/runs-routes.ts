import {
  ChannelApplyRunsResponseSchema,
  ChannelsQuerySchema,
  IdParamSchema,
} from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { authOf, svc } from '../passes/http.ts';
import type { TemplateRef } from './repo.ts';
import { listRuns, rotating } from './repo-runs.ts';
import { blockingWindow, openWindows } from './windows.ts';

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
      const ctx = svc(c);
      const mode = modeOf(authOf(c));
      const runs = await listRuns(ctx.env.DB, template.orgId, mode, template.id);
      // The same windows that hold the gate: a running replace run is waiting while one is open.
      const holding = runs.some((r) => r.state === 'running' && rotating(r))
        ? blockingWindow(
            await openWindows(ctx, template.orgId, mode, template.id, ctx.clock.now(), 1),
          )
        : undefined;
      return c.json(
        runs.map((r) => ({
          id: r.id,
          state: r.state,
          dueAt: r.dueAt,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          counts: { ...r.counts },
          errorCode: r.errorCode,
          waiting:
            holding && r.state === 'running' && rotating(r)
              ? { name: holding.name, until: holding.closesAt }
              : null,
        })),
      );
    },
  );
}
