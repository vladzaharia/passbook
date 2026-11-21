import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  IdParamSchema,
  ReleaseResponseSchema,
  ReleaseTemplateQuerySchema,
  ReleaseTemplateSchema,
} from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import {
  BadRequestError,
  ConflictError,
  toProblem,
  ValidationError,
} from '../../platform/errors.ts';
import { idempotencyKeyHeader, idempotentJson, principalOf } from '../../platform/idempotency.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, orgIdOf } from '../passes/http.ts';
import { authorizeTemplateWrite } from './access.ts';
import { ReviewRequiredError, releaseTemplate } from './release-flow.ts';
import { scopedTemplate } from './releases-domain.ts';

type Router = OpenAPIHono<AppBindings>;

/** The 409 body: the problem document with the plan that stopped it. */
function reviewRequiredResponse(error: ReviewRequiredError, requestId: string): Response {
  const { headers, ...problem } = toProblem(error, requestId);
  return new Response(JSON.stringify({ ...problem, plan: error.plan }), {
    status: 409,
    headers: {
      'content-type': 'application/problem+json',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

async function once<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Why: this route answers a reused key with 409, like every other conflict of the release.
    if (error instanceof ValidationError && error.code === 'IDEMPOTENCY_KEY_REUSED')
      throw new ConflictError(error.message, 'IDEMPOTENCY_KEY_REUSED');
    throw error;
  }
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
      const options = {
        scope: request ? ('templates:write' as const) : ('templates:publish' as const),
        capability: request ? ('templates:author' as const) : ('templates:publish' as const),
        request,
      };
      // Why: a replay returns the stored answer, so the template and the caller are proven before any of it.
      await scopedTemplate(ctx, auth, id, { orgId, mode: modeOf(auth), provider: 'apple' });
      await authorizeTemplateWrite(ctx, auth, orgId, options.capability);
      try {
        if (c.req.valid('query').dryRun)
          return c.json(
            await releaseTemplate(ctx, auth, id, orgId, body, { ...options, dryRun: true }),
          );
        if (idempotencyKeyHeader(c.req.header('idempotency-key')) === undefined)
          throw new BadRequestError('Send an Idempotency-Key header.', 'IDEMPOTENCY_KEY_REQUIRED');
        return await once(() =>
          idempotentJson(
            c,
            ctx,
            { orgId, mode: modeOf(auth), principal: principalOf(auth), body },
            200,
            () => releaseTemplate(ctx, auth, id, orgId, body, { ...options, dryRun: false }),
          ),
        );
      } catch (error) {
        if (error instanceof ReviewRequiredError)
          return reviewRequiredResponse(error, c.var.requestId);
        throw error;
      }
    });
}
