import {
  BulkPassChannelsResponseSchema,
  BulkPassChannelsSchema,
  ChannelsQuerySchema,
  IdParamSchema,
  PassChannelsResponseSchema,
  PutPassChannelsSchema,
  PutTemplateChannelsResponseSchema,
  PutTemplateChannelsSchema,
  ResetTemplatePassesResponseSchema,
  ResetTemplatePassesSchema,
  TemplateChannelsResponseSchema,
} from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { actorOfAuth } from '../operations/start-org.ts';
import { setupCan } from '../orgs/pass-setup.ts';
import { activeMembership } from '../orgs/repo-members.ts';
import {
  actorFor,
  assertOrg,
  authOf,
  passScopeOf,
  svc,
  tenantAuthorityOf,
} from '../passes/http.ts';
import { tenantPassForRead, tenantPassForWrite } from '../passes/pass-access.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { assertWritableMode } from '../passes/scope.ts';
import * as repo from './repo.ts';
import { registerChannelRunRoutes } from './runs-routes.ts';
import { passChannels, templateChannels } from './service.ts';
import { resetTemplatePasses } from './service-reset.ts';
import { putTemplateChannels } from './service-template.ts';
import { bulkPassChannels, putPassChannels } from './service-write.ts';

type Router = ReturnType<typeof createRouter>;
type Ctx = Parameters<typeof authOf>[0];

/** GET and PUT /api/v1/passes/{id}/channels, POST /api/v1/passes/bulk/channels. */
export function registerPassChannelRoutes(passesRoutes: Router): void {
  register(
    passesRoutes,
    'passes',
    {
      method: 'post',
      path: '/bulk/channels',
      summary: 'Turn channels on, off or back to the template for up to 100 passes',
      body: BulkPassChannelsSchema,
      response: BulkPassChannelsResponseSchema,
    },
    async (c) => {
      const body = c.req.valid('json');
      if (body.orgId) assertOrg(c, body.orgId);
      const ctx = svc(c);
      const scope = passScopeOf(c);
      const ids = [...new Set(body.ids)];
      const first = body.orgId ? null : await getPass(ctx.env.DB, ids[0] ?? '', scope);
      const orgId = body.orgId ?? first?.orgId;
      if (!orgId) throw new NotFoundError('Some passes were not found.', 'PASS_NOT_FOUND');
      const authority = await tenantAuthorityOf(ctx, authOf(c), orgId, 'passes:operate');
      const pinned = { ...scope, orgId: authority.orgId };
      const passes = [];
      for (const id of ids) {
        const pass = await getPass(ctx.env.DB, id, pinned);
        if (!pass) throw new NotFoundError('Some passes were not found.', 'PASS_NOT_FOUND');
        assertWritableMode(pinned, pass.mode);
        passes.push(pass);
      }
      return c.json(
        await bulkPassChannels(ctx, actorFor(c), authority, passes, body, actorOfAuth(authOf(c))),
      );
    },
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'get',
      path: '/{id}/channels',
      summary: "A pass's channels: effective state, source and overrides",
      params: IdParamSchema,
      response: PassChannelsResponseSchema,
    },
    async (c) => {
      const { id } = c.req.valid('param');
      const { pass } = await tenantPassForRead(svc(c), authOf(c), id, passScopeOf(c));
      const can = await setupCan(svc(c), authOf(c), pass.orgId);
      return c.json(await passChannels(svc(c), pass, can));
    },
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'put',
      path: '/{id}/channels',
      summary: 'Override channels for one pass; null returns a channel to its template',
      params: IdParamSchema,
      body: PutPassChannelsSchema,
      response: PassChannelsResponseSchema,
    },
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      if (body.orgId) assertOrg(c, body.orgId);
      const { pass, authority } = await tenantPassForWrite(svc(c), authOf(c), id, passScopeOf(c));
      if (body.orgId && body.orgId !== pass.orgId)
        throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
      return c.json(await putPassChannels(svc(c), actorFor(c), authority, pass, body));
    },
  );
}

/** The template by id and the org the caller names for it; outsiders see "not found". */
async function templateFor(
  c: Ctx,
  capability: 'templates:read' | 'templates:publish',
  requestedOrg: string | undefined,
) {
  const ctx = svc(c);
  const auth = authOf(c);
  const found = await repo.templateOwner(ctx.env.DB, c.req.param('id') ?? '');
  const notFound = () => new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  if (!found) throw notFound();
  if (found.ownerOrgId && requestedOrg && requestedOrg !== found.ownerOrgId) throw notFound();
  const orgId = found.ownerOrgId ?? requestedOrg ?? (auth.kind === 'api_key' ? auth.orgId : null);
  if (!orgId)
    throw new ValidationError('Choose an organization.', [
      { path: 'orgId', message: 'Choose an organization.' },
    ]);
  const template = { id: found.id, orgId, activeVersion: found.activeVersion };
  try {
    assertOrg(c, orgId);
    const authority = await tenantAuthorityOf(ctx, auth, orgId, capability);
    return { template, authority };
  } catch (error) {
    if (error instanceof ForbiddenError) {
      // Outsiders do not learn that the template exists.
      if (auth.kind === 'api_key' && auth.orgId !== null && auth.orgId !== orgId) throw notFound();
      if (auth.kind === 'session' && !(await activeMembership(ctx.env.DB, auth.userId, orgId)))
        throw notFound();
    }
    throw error;
  }
}

/** GET and PUT /api/v1/templates/{id}/channels: per mode, the caller's mode. */
export function registerTemplateChannelRoutes(templatesRoutes: Router): void {
  register(
    templatesRoutes,
    'templates',
    {
      method: 'get',
      path: '/{id}/channels',
      summary: "A template's channel policy and what it allows now, in this mode",
      params: IdParamSchema,
      query: ChannelsQuerySchema,
      response: TemplateChannelsResponseSchema,
    },
    async (c) => {
      const { template } = await templateFor(c, 'templates:read', c.req.valid('query').orgId);
      const can = await setupCan(svc(c), authOf(c), template.orgId);
      return c.json(await templateChannels(svc(c), template, modeOf(authOf(c)), can));
    },
  );

  registerChannelRunRoutes(templatesRoutes, templateFor);

  register(
    templatesRoutes,
    'templates',
    {
      method: 'put',
      path: '/{id}/channels',
      summary: "Set a template's channels to on, off or never; dryRun shows the effect",
      params: IdParamSchema,
      body: PutTemplateChannelsSchema,
      response: PutTemplateChannelsResponseSchema,
    },
    async (c) => {
      const body = c.req.valid('json');
      const { template, authority } = await templateFor(c, 'templates:publish', body.orgId);
      const can = await setupCan(svc(c), authOf(c), template.orgId);
      return c.json(
        await putTemplateChannels(
          svc(c),
          actorFor(c),
          authority,
          template,
          modeOf(authOf(c)),
          can,
          body,
        ),
      );
    },
  );

  register(
    templatesRoutes,
    'templates',
    {
      method: 'post',
      path: '/{id}/channels/reset-passes',
      summary:
        'Passes with their own channel choice follow the template again; repeat while remaining is above 0',
      params: IdParamSchema,
      body: ResetTemplatePassesSchema,
      response: ResetTemplatePassesResponseSchema,
    },
    async (c) => {
      const body = c.req.valid('json');
      const { template } = await templateFor(c, 'templates:publish', body.orgId);
      // Clearing a pass override is a pass operation: the caller needs that right as well.
      const authority = await tenantAuthorityOf(
        svc(c),
        authOf(c),
        template.orgId,
        'passes:operate',
      );
      return c.json(
        await resetTemplatePasses(
          svc(c),
          actorFor(c),
          authority,
          template,
          modeOf(authOf(c)),
          body,
        ),
      );
    },
  );
}
