import { PassListQuerySchema, PassListSchema } from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import { workbenchPinOf } from '../../platform/auth-workbench.ts';
import { ForbiddenError, ValidationError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { assertMatchUnambiguous, listFilterOf } from './find.ts';
import { authOf, svc } from './http.ts';
import { listPassesAcross } from './list-all.ts';
import { requireTenantPassRead } from './pass-access.ts';
import { countPasses } from './repo-list.ts';
import { listPassSummaries } from './service.ts';

export function registerListRoute(passesRoutes: ReturnType<typeof createRouter>): void {
  register(
    passesRoutes,
    'passes',
    {
      method: 'get',
      path: '/',
      summary: 'List passes',
      query: PassListQuerySchema,
      response: PassListSchema,
    },
    async (c) => {
      const q = c.req.valid('query');
      const ctx = svc(c);
      const auth = authOf(c);
      const { limit, cursor, count, orgId: given, orgIds, ...filter } = q;
      const across = given === 'all' || given === null;
      if (orgIds && !across)
        throw new ValidationError(
          'Send orgId=all with orgIds.',
          [{ path: 'orgIds', message: 'Needs orgId=all.' }],
          'VALIDATION',
        );
      if (across) {
        // A match walks json_each per row: bound it by an organization, and read its keys unambiguously.
        if (q.match) throw matchNeedsOrg();
        // `null` is the older spelling of `all`, and only a global key may send it.
        if (given === null && (auth.kind !== 'api_key' || auth.orgId !== null))
          throw new ForbiddenError(
            'A global API key is required for platform-wide pass lists.',
            'ORG_FORBIDDEN',
          );
        return c.json(
          await listPassesAcross(
            ctx,
            auth,
            { mode: modeOf(auth), filter, orgIds },
            { cursor, limit, count: count === true },
          ),
        );
      }
      // A key bound to an org lists that org by default. A global key must say so: `orgId=null` is explicit.
      const orgId =
        given !== undefined
          ? given
          : auth.kind === 'api_key' && auth.orgId !== null
            ? auth.orgId
            : workbenchPinOf(auth)?.orgId;
      if (orgId === undefined)
        throw new ValidationError('Send orgId to choose an organization.', [], 'ORG_REQUIRED');
      await requireTenantPassRead(ctx, auth, orgId);
      const mode = modeOf(auth);
      const list = listFilterOf(ctx, { orgId, mode }, filter);
      if (!list) return c.json({ items: [], nextCursor: null, ...(count ? { count: 0 } : {}) });
      if (q.match && !q.templateId) await assertMatchUnambiguous(ctx, orgId, mode, q.match);
      const page = await listPassSummaries(ctx, { ...list, ...(cursor ? { cursor } : {}), limit });
      return c.json(count ? { ...page, count: await countPasses(ctx.env.DB, list) } : page);
    },
  );
}

const matchNeedsOrg = () =>
  new ValidationError(
    'Pick an organization to filter by input.',
    [{ path: 'match', message: 'Needs orgId.' }],
    'MATCH_NEEDS_TEMPLATE',
  );
