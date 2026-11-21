import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  ApproveTemplateCandidateSchema,
  CreateTemplateCandidateSchema,
  CursorQuerySchema,
  IdParamSchema,
  PromoteTemplateSchema,
  PublishTemplateReleaseSchema,
  RollbackTemplateReleaseSchema,
  TemplateApprovalSchema,
  TemplateCandidateListSchema,
  TemplateCandidateParamSchema,
  TemplateCandidateSchema,
  TemplateReleaseImpactQuerySchema,
  TemplateReleaseImpactSchema,
  TemplateReleaseListSchema,
  TemplateReleaseQueryScopeSchema,
  TemplateReleaseSchema,
} from '../../../shared/contracts/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, orgIdOf } from '../passes/http.ts';
import { releaseImpact } from './release-impact.ts';
import {
  approveCandidate,
  createCandidate,
  listCandidates,
  listReleases,
  publishRelease,
  rollbackRelease,
} from './releases.ts';
import { promoteToLive } from './releases-promote.ts';

type Router = OpenAPIHono<AppBindings>;

export function registerTemplateReleases(router: Router): void {
  register(
    router,
    'templates',
    {
      method: 'get',
      path: '/{id}/candidates',
      summary: 'List template release candidates',
      params: IdParamSchema,
      query: TemplateReleaseQueryScopeSchema.extend(CursorQuerySchema.shape),
      response: TemplateCandidateListSchema,
    },
    async (c) => {
      const auth = authOf(c);
      const q = c.req.valid('query');
      return c.json(
        await listCandidates(serviceContext(c), auth, c.req.valid('param').id, {
          ...q,
          orgId: orgIdOf(auth, q.orgId),
        }),
      );
    },
  );

  register(
    router,
    'templates',
    {
      method: 'post',
      path: '/{id}/candidates',
      summary: 'Create a template release candidate',
      auth: { scope: 'templates:write', capability: 'templates:author' },
      params: IdParamSchema,
      body: CreateTemplateCandidateSchema,
      response: TemplateCandidateSchema,
      status: 201,
    },
    async (c) =>
      c.json(
        await createCandidate(
          serviceContext(c),
          c.var.auth,
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
        201,
      ),
  );

  register(
    router,
    'templates',
    {
      method: 'post',
      path: '/{id}/candidates/promote',
      summary: 'Promote a version released in Test to a Live candidate',
      params: IdParamSchema,
      body: PromoteTemplateSchema,
      response: TemplateCandidateSchema,
      status: 201,
    },
    async (c) =>
      c.json(
        await promoteToLive(
          serviceContext(c),
          c.var.auth,
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
        201,
      ),
  );

  register(
    router,
    'templates',
    {
      method: 'post',
      path: '/{id}/candidates/{candidateId}/approve',
      summary: 'Approve a template release candidate (a key only in Test)',
      auth: { scope: 'templates:review', capability: 'templates:review' },
      params: TemplateCandidateParamSchema,
      body: ApproveTemplateCandidateSchema,
      response: TemplateApprovalSchema,
      status: 201,
    },
    async (c) =>
      c.json(
        await approveCandidate(
          serviceContext(c),
          c.var.auth,
          c.req.valid('param').id,
          c.req.valid('param').candidateId,
          c.req.valid('json'),
        ),
        201,
      ),
  );

  register(
    router,
    'templates',
    {
      method: 'get',
      path: '/{id}/releases',
      summary: 'List template releases',
      params: IdParamSchema,
      query: TemplateReleaseQueryScopeSchema.extend(CursorQuerySchema.shape),
      response: TemplateReleaseListSchema,
    },
    async (c) => {
      const auth = authOf(c);
      const q = c.req.valid('query');
      return c.json(
        await listReleases(serviceContext(c), auth, c.req.valid('param').id, {
          ...q,
          orgId: orgIdOf(auth, q.orgId),
        }),
      );
    },
  );

  register(
    router,
    'templates',
    {
      method: 'get',
      path: '/{id}/releases/impact',
      summary: 'What publishing or rolling back to a version changes, and for how many passes',
      params: IdParamSchema,
      query: TemplateReleaseImpactQuerySchema,
      response: TemplateReleaseImpactSchema,
    },
    async (c) => {
      const auth = authOf(c);
      const q = c.req.valid('query');
      return c.json(
        await releaseImpact(serviceContext(c), auth, c.req.valid('param').id, {
          ...q,
          orgId: orgIdOf(auth, q.orgId),
        }),
      );
    },
  );

  register(
    router,
    'templates',
    {
      method: 'post',
      path: '/{id}/releases/rollback',
      summary: 'Roll back to a prior template release',
      params: IdParamSchema,
      body: RollbackTemplateReleaseSchema,
      response: TemplateReleaseSchema,
      status: 201,
    },
    async (c) =>
      c.json(
        await rollbackRelease(
          serviceContext(c),
          c.var.auth,
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
        201,
      ),
  );

  register(
    router,
    'templates',
    {
      method: 'post',
      path: '/{id}/releases',
      summary: 'Publish an approved template release (a key only in Test)',
      auth: { scope: 'templates:publish', capability: 'templates:publish' },
      params: IdParamSchema,
      body: PublishTemplateReleaseSchema,
      response: TemplateReleaseSchema,
      status: 201,
    },
    async (c) =>
      c.json(
        await publishRelease(
          serviceContext(c),
          c.var.auth,
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
        201,
      ),
  );
}
