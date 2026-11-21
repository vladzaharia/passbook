import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  IdParamSchema,
  ReviewResultSchema,
  ReviewTemplateSchema,
  TemplateReviewListSchema,
  TemplateReviewQuerySchema,
} from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { declareKeyAccess } from '../../platform/openapi-security.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, orgIdOf, requireTenantSessionOrApiKey } from '../passes/http.ts';
import { ReviewRequiredError } from './release-flow.ts';
import { reviewRequiredResponse } from './release-flow-route.ts';
import { scopedTemplate } from './releases-domain.ts';
import { reviewTemplate } from './review-flow.ts';
import { listTemplateReviews } from './review-inbox.ts';

type Router = OpenAPIHono<AppBindings>;

export function registerTemplateReview(router: Router): void {
  register(
    router,
    'templates',
    {
      method: 'post',
      path: '/{id}/review',
      summary: 'Approve a requested template version in Test and Live, and release it when asked',
      auth: { scope: 'templates:review', capability: 'templates:review' },
      params: IdParamSchema,
      body: ReviewTemplateSchema,
      response: ReviewResultSchema,
      status: 200,
    },
    async (c) => {
      const auth = authOf(c);
      const body = c.req.valid('json');
      const id = c.req.valid('param').id;
      const orgId = orgIdOf(auth, body.orgId);
      const ctx = serviceContext(c);
      await scopedTemplate(ctx, auth, id, { orgId, mode: modeOf(auth), provider: 'apple' });
      try {
        return c.json(await reviewTemplate(ctx, auth, id, orgId, body));
      } catch (error) {
        if (error instanceof ReviewRequiredError)
          return reviewRequiredResponse(error, c.var.requestId);
        throw error;
      }
    },
  );
}

/** `GET /template-reviews`: the reviewer inbox. */
export const templateReviewsRoutes = createRouter();
templateReviewsRoutes.use(
  '*',
  declareKeyAccess(requireTenantSessionOrApiKey('templates:read'), { read: ['templates:read'] }),
);

register(
  templateReviewsRoutes,
  'templates',
  {
    method: 'get',
    path: '/',
    summary: 'List template versions waiting for review',
    query: TemplateReviewQuerySchema,
    response: TemplateReviewListSchema,
  },
  async (c) => {
    const auth = authOf(c);
    const q = c.req.valid('query');
    return c.json(
      await listTemplateReviews(serviceContext(c), auth, { ...q, orgId: orgIdOf(auth, q.orgId) }),
    );
  },
);
