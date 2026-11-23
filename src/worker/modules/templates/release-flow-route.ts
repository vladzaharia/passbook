import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  IdParamSchema,
  ReleaseResponseSchema,
  ReleaseTemplateQuerySchema,
  ReleaseTemplateSchema,
} from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import { proveCapability } from '../../platform/auth-capability.ts';
import type { AppBindings } from '../../platform/context.ts';
import { BadRequestError, ForbiddenError, toProblem } from '../../platform/errors.ts';
import { idempotencyKeyHeader, idempotentJson, principalOf } from '../../platform/idempotency.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, orgIdOf } from '../passes/http.ts';
import { authorizeTemplateWrite, type TemplateCapability } from './access.ts';
import { ReviewRequiredError, releaseTemplate } from './release-flow.ts';
import type { StepScope } from './release-flow-plan.ts';
import { scopedTemplate } from './releases-domain.ts';
import { notifyReviewers } from './review-notify.ts';

type Router = OpenAPIHono<AppBindings>;

/** The 409 body: the problem document with the plan that stopped it. */
export function reviewRequiredResponse(error: ReviewRequiredError, requestId: string): Response {
  const { headers, ...problem } = toProblem(error, requestId);
  return new Response(
    JSON.stringify({
      ...problem,
      plan: error.plan,
      ...(error.approved ? { approved: error.approved } : {}),
    }),
    {
      status: 409,
      headers: {
        'content-type': 'application/problem+json',
        'cache-control': 'no-store',
        ...headers,
      },
    },
  );
}

export function registerTemplateReleaseFlow(router: Router): void {
  const spec = (path: string, request: boolean) => ({
    method: 'post' as const,
    path,
    summary: request
      ? 'Request review of a template version (Idempotency-Key required)'
      : 'Release a template version to Test and Live in one call (Idempotency-Key required; dryRun previews)',
    auth: request
      ? { scope: 'templates:write' as const, capability: 'templates:author' as const }
      : { scope: 'templates:publish' as const, capability: 'templates:publish' as const },
    params: IdParamSchema,
    query: ReleaseTemplateQuerySchema,
    body: ReleaseTemplateSchema,
    response: ReleaseResponseSchema,
    status: 200 as const,
  });

  for (const [path, request] of [
    ['/{id}/release', false],
    ['/{id}/review-requests', true],
  ] as const)
    register(router, 'templates', spec(path, request), async (c) => {
      const auth = authOf(c);
      const body = c.req.valid('json');
      const id = c.req.valid('param').id;
      const orgId = orgIdOf(auth, body.orgId);
      const ctx = serviceContext(c);
      const dryRun = c.req.valid('query').dryRun === true;
      const publish = {
        scope: 'templates:publish' as const,
        capability: 'templates:publish' as const,
      };
      let step: { scope: StepScope; capability: TemplateCapability } = request
        ? { scope: 'templates:write', capability: 'templates:author' }
        : publish;
      // Why: a replay returns the stored answer, so the template and the caller are proven before any of it.
      await scopedTemplate(ctx, auth, id, { orgId, mode: modeOf(auth), provider: 'apple' });
      let previewOnly = false;
      try {
        await authorizeTemplateWrite(ctx, auth, orgId, step.capability, { liveRequest: request });
      } catch (error) {
        // Why: a dry run writes nothing, so a session that cannot publish but can review may read
        // the plan it is asked to approve. Publish stays the path for everyone who has it.
        if (!(dryRun && !request && auth.kind === 'session' && error instanceof ForbiddenError))
          throw error;
        step = { scope: 'templates:review', capability: 'templates:review' };
        await authorizeTemplateWrite(ctx, auth, orgId, 'templates:review');
        previewOnly = true;
      }
      // Dry run only: the route declares publish, and this proves review in its place. A real
      // release never reaches here, because it needs the publish authorization above.
      if (previewOnly && dryRun) proveCapability(auth, 'templates:publish');
      const options = { ...step, request, onReviewRequested: notifyReviewers };
      try {
        if (c.req.valid('query').dryRun)
          return c.json(
            await releaseTemplate(ctx, auth, id, orgId, body, { ...options, dryRun: true }),
          );
        if (idempotencyKeyHeader(c.req.header('idempotency-key')) === undefined)
          throw new BadRequestError('Send an Idempotency-Key header.', 'IDEMPOTENCY_KEY_REQUIRED');
        return await idempotentJson(
          c,
          ctx,
          { orgId, mode: 'release', principal: principalOf(auth), body },
          200,
          () => releaseTemplate(ctx, auth, id, orgId, body, { ...options, dryRun: false }),
        );
      } catch (error) {
        if (error instanceof ReviewRequiredError)
          return reviewRequiredResponse(error, c.var.requestId);
        throw error;
      }
    });
}
