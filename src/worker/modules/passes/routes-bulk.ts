import {
  BulkPassActionResponseSchema,
  BulkPassActionSchema,
  BulkReissueResponseSchema,
  BulkReissueSchema,
} from '../../../shared/contracts/index.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { idempotencyKeyOf, sendOnce } from '../delivery/idempotent-send.ts';
import { startBulkReissue } from './bulk.ts';
import { bulkPassAction, selectBulkPasses } from './bulk-actions.ts';
import {
  actorFor,
  assertOrg,
  authOf,
  passScopeOf,
  requireTenantSession,
  svc,
  tenantAuthorityOf,
} from './http.ts';
import { getPass } from './repo-read-pass.ts';

/** Many-pass actions: void, email or remove a selection, and template-wide reissues. */
export function registerBulkRoutes(passesRoutes: ReturnType<typeof createRouter>): void {
  passesRoutes.use('/bulk-reissue', requireTenantSession);

  register(
    passesRoutes,
    'passes',
    {
      method: 'post',
      path: '/bulk',
      summary: 'Void, email or remove up to 100 passes of one org (Idempotency-Key for email)',
      body: BulkPassActionSchema,
      response: BulkPassActionResponseSchema,
    },
    async (c) => {
      const body = c.req.valid('json');
      if (body.orgId) assertOrg(c, body.orgId);
      const ctx = svc(c);
      const scope = passScopeOf(c);
      let orgId = body.orgId;
      if (!orgId) {
        const firstId = body.ids[0];
        if (!firstId) throw new NotFoundError('Some passes were not found.', 'PASS_NOT_FOUND');
        const first = await getPass(ctx.env.DB, firstId, scope);
        if (!first) throw new NotFoundError('Some passes were not found.', 'PASS_NOT_FOUND');
        orgId = first.orgId;
      }
      const authority = await tenantAuthorityOf(ctx, authOf(c), orgId, 'passes:operate');
      const authorizedScope = { ...scope, orgId: authority.orgId };
      let selection: Awaited<ReturnType<typeof selectBulkPasses>>;
      try {
        selection = await selectBulkPasses(ctx, body, authorizedScope);
      } catch (error) {
        // An id outside the pinned org is "not found", unless the caller may act on that org too: then the
        // selection spans organizations, which is its own refusal. Orgs the caller cannot act on stay hidden.
        if (error instanceof NotFoundError)
          for (const id of new Set(body.ids)) {
            const other = await getPass(ctx.env.DB, id, scope);
            if (!other || other.orgId === orgId) continue;
            const allowed = await tenantAuthorityOf(
              ctx,
              authOf(c),
              other.orgId,
              'passes:operate',
            ).then(
              () => true,
              () => false,
            );
            if (allowed)
              throw new ValidationError('Choose passes of one organization.', [], 'ORG_MIXED');
          }
        throw error;
      }
      let queued = false;
      const run = () =>
        bulkPassAction(ctx, actorFor(c), body, authorizedScope, authority, selection, () => {
          queued = true;
        });
      const key = idempotencyKeyOf(c.req.header('idempotency-key'));
      if (key === undefined || body.action !== 'send_email') return c.json(await run());
      const { value } = await sendOnce(
        ctx,
        {
          orgId: selection.orgId,
          scope: 'bulk-send',
          key,
          request: [...new Set(body.ids)].sort(),
          authority,
          progress: () => queued,
        },
        run,
      );
      return c.json(value);
    },
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'post',
      path: '/bulk-reissue',
      summary: 'Rebuild passes of a template',
      body: BulkReissueSchema,
      status: 202,
      response: BulkReissueResponseSchema,
    },
    async (c) => {
      const body = c.req.valid('json');
      const ctx = svc(c);
      const auth = authOf(c);
      const mode = passScopeOf(c).mode;
      if (!body.orgId && (auth.kind !== 'session' || !auth.roles.includes('admin')))
        throw new ForbiddenError('Admin access is required.');
      const authority = body.orgId
        ? await tenantAuthorityOf(ctx, auth, body.orgId, 'passes:operate')
        : undefined;
      const platformSession =
        !body.orgId && auth.kind === 'session'
          ? { userId: auth.userId, sessionId: auth.sessionId }
          : undefined;
      const workflowInstanceId = await startBulkReissue(ctx, actorFor(c), body, {
        ...(authority ? { authority } : {}),
        ...(platformSession ? { platformSession } : {}),
        mode,
      });
      return c.json({ workflowInstanceId }, 202);
    },
  );
}
