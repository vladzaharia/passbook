import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  ApproveTemplateCandidateSchema,
  CreateTemplateCandidateSchema,
  IdParamSchema,
  PublishTemplateReleaseSchema,
  RollbackTemplateReleaseSchema,
  TemplateApprovalSchema,
  TemplateCandidateListSchema,
  TemplateCandidateParamSchema,
  TemplateCandidateSchema,
  TemplateReleaseImpactQuerySchema,
  TemplateReleaseImpactSchema,
  TemplateReleaseListSchema,
  TemplateReleaseSchema,
  TemplateReleaseScopeSchema,
} from '../../../shared/contracts/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { releaseImpact } from './release-impact.ts';
import {
  approveCandidate,
  createCandidate,
  listCandidates,
  listReleases,
  publishRelease,
  rollbackRelease,
} from './releases.ts';

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
      query: TemplateReleaseScopeSchema,
      response: TemplateCandidateListSchema,
    },
    async (c) =>
      c.json(
        await listCandidates(
          serviceContext(c),
          c.var.auth,
          c.req.valid('param').id,
          c.req.valid('query'),
        ),
      ),
  );

  register(
    router,
    'templates',
    {
      method: 'post',
      path: '/{id}/candidates',
      summary: 'Create a template release candidate',
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
      path: '/{id}/candidates/{candidateId}/approve',
      summary: 'Approve a template release candidate',
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
      query: TemplateReleaseScopeSchema,
      response: TemplateReleaseListSchema,
    },
    async (c) =>
      c.json(
        await listReleases(
          serviceContext(c),
          c.var.auth,
          c.req.valid('param').id,
          c.req.valid('query'),
        ),
      ),
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
    async (c) =>
      c.json(
        await releaseImpact(
          serviceContext(c),
          c.var.auth,
          c.req.valid('param').id,
          c.req.valid('query'),
        ),
      ),
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
      summary: 'Publish an approved template release',
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
