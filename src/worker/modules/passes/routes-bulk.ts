import {
  BulkPassActionResponseSchema,
  BulkReissueResponseSchema,
  BulkReissueSchema,
} from '../../../shared/contracts/index.ts';
import { BulkPassRequestSchema } from '../../../shared/contracts/pass-selection.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { idempotencyKeyOf, sendOnce } from '../delivery/idempotent-send.ts';
import { actorOfAuth } from '../operations/start-org.ts';
import { startBulkReissue } from './bulk.ts';
import { bulkPassAction, selectBulkPasses } from './bulk-actions.ts';
import { resolveFilterPasses } from './find.ts';
import { actorFor, assertOrg, authOf, passScopeOf, svc, tenantAuthorityOf } from './http.ts';
import { limitKeyReissues } from './key-reissue-limit.ts';
import { getPass } from './repo-read-pass.ts';

/** Many-pass actions: void, email or remove a selection, and template-wide reissues. */
export function registerBulkRoutes(passesRoutes: ReturnType<typeof createRouter>): void {
  register(
    passesRoutes,
    'passes',
    {
      method: 'post',
      path: '/bulk',
      summary:
        'Void, email or remove up to 100 passes of one org, or all passes a filter matches (Idempotency-Key for email)',
      body: BulkPassRequestSchema,
      response: BulkPassActionResponseSchema,
    },
    async (c) => {
      const { selection: chosen, ...rest } = c.req.valid('json');
      if (rest.orgId) assertOrg(c, rest.orgId);
      // Refused before anything is looked up: a reserved key never reaches the table.
      const key = idempotencyKeyOf(c.req.header('idempotency-key'));
      const ctx = svc(c);
      const scope = passScopeOf(c);
      const filterRun = chosen !== undefined && 'filter' in chosen ? chosen : undefined;
      let ids = rest.ids ?? (chosen && 'ids' in chosen ? chosen.ids : []);
      let orgId = rest.orgId;
      if (filterRun) {
        const auth = authOf(c);
        orgId ??= auth.kind === 'api_key' ? (auth.orgId ?? undefined) : undefined;
        if (!orgId)
          throw new ValidationError('Send orgId to choose an organization.', [], 'ORG_REQUIRED');
        assertOrg(c, orgId);
      } else if (!orgId) {
        const firstId = ids[0];
        if (!firstId) throw new NotFoundError('Some passes were not found.', 'PASS_NOT_FOUND');
        const first = await getPass(ctx.env.DB, firstId, scope);
        if (!first) throw new NotFoundError('Some passes were not found.', 'PASS_NOT_FOUND');
        orgId = first.orgId;
      }
      const authority = await tenantAuthorityOf(ctx, authOf(c), orgId, 'passes:operate');
      const authorizedScope = { ...scope, orgId: authority.orgId };
      if (filterRun)
        ids = (
          await resolveFilterPasses(
            ctx,
            { orgId: authority.orgId, mode: scope.mode },
            filterRun.filter,
            filterRun.expectCount,
            true,
          )
        ).map((p) => p.id);
      const body = { ...rest, ids };
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
      summary: 'Rebuild passes of a template in your org; a key needs passes:write',
      body: BulkReissueSchema,
      status: 202,
      response: BulkReissueResponseSchema,
    },
    async (c) => {
      const body = c.req.valid('json');
      const ctx = svc(c);
      const auth = authOf(c);
      const mode = passScopeOf(c).mode;
      // A key rebuilds its own org; only a platform admin session may omit the org.
      const orgId = body.orgId ?? (auth.kind === 'api_key' ? (auth.orgId ?? undefined) : undefined);
      if (!orgId && (auth.kind !== 'session' || !auth.roles.includes('admin')))
        throw new ForbiddenError('Admin access is required.');
      if (orgId) assertOrg(c, orgId);
      const authority = orgId
        ? await tenantAuthorityOf(ctx, auth, orgId, 'passes:operate')
        : undefined;
      if (auth.kind === 'api_key') await limitKeyReissues(ctx, auth.keyId);
      const platformSession =
        !orgId && auth.kind === 'session'
          ? { userId: auth.userId, sessionId: auth.sessionId }
          : undefined;
      let operationId: string | null = null;
      const workflowInstanceId = await startBulkReissue(
        ctx,
        actorFor(c),
        { ...body, orgId },
        {
          ...(authority ? { authority } : {}),
          ...(platformSession ? { platformSession } : {}),
          mode,
          // A user-started rebuild shows as an operation; branding and system runs have their own screens.
          ...(body.cause === undefined ||
          body.cause === 'resign' ||
          body.cause === 'template_upgrade'
            ? {
                operation: {
                  actor: actorOfAuth(auth),
                  onStarted: (op: { id: string }) => {
                    operationId = op.id;
                  },
                },
              }
            : {}),
        },
      );
      return c.json({ workflowInstanceId, operationId }, 202);
    },
  );
}
