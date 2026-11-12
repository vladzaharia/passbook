import {
  CreatePassSchema,
  IdParamSchema,
  PassDetailSchema,
  UpdatePassSchema,
} from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import { BadRequestError, ConflictError, ValidationError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { createPassIdempotent } from './create.ts';
import { effectiveApiRelease } from './create-release.ts';
import {
  actorFor,
  assertOrg,
  authOf,
  type C,
  passScopeOf,
  svc,
  tenantAuthorityOf,
} from './http.ts';
import { tenantPassForWrite } from './pass-access.ts';
import { updatePass } from './service.ts';

function ifMatch(c: C): number | undefined {
  const raw = c.req.header('if-match');
  if (raw === undefined) return undefined;
  const match = /^(?:W\/)?"?(\d{1,12})"?$/.exec(raw.trim());
  if (!match?.[1])
    throw new BadRequestError('If-Match must be the pass version.', 'IF_MATCH_INVALID');
  return Number(match[1]);
}

/** Create and update: the two routes that publish a pass from caller input. */
export function registerWriteRoutes(passesRoutes: ReturnType<typeof createRouter>): void {
  register(
    passesRoutes,
    'passes',
    {
      method: 'post',
      path: '/',
      summary: 'Create a pass (Idempotency-Key supported)',
      body: CreatePassSchema,
      status: 201,
      response: PassDetailSchema,
    },
    async (c) => {
      const body = c.req.valid('json');
      const auth = authOf(c);
      const orgId = body.orgId ?? (auth.kind === 'api_key' ? auth.orgId : null);
      if (!orgId)
        throw new ValidationError('Send orgId to choose an organization.', [], 'ORG_REQUIRED');
      assertOrg(c, orgId);
      const mode = body.mode ?? (auth.kind === 'api_key' ? modeOf(auth) : undefined);
      if (mode === undefined)
        throw new ValidationError('Review the mode and template version before issuing the pass.');
      if (mode !== modeOf(auth))
        throw new ConflictError(
          'The reviewed mode changed. Review the pass again before issuing it.',
          'MODE_MISMATCH',
        );
      const ctx = svc(c);
      const authority = await tenantAuthorityOf(ctx, auth, orgId, 'passes:operate');
      const key = c.req.header('idempotency-key')?.trim();
      if (key !== undefined && (key.length < 1 || key.length > 200))
        throw new BadRequestError(
          'Idempotency-Key must be 1 to 200 characters.',
          'IDEMPOTENCY_KEY_INVALID',
        );
      const pinned = [body.templateVersion, body.releaseId, body.releaseGeneration];
      let review: { templateVersion: string; releaseId: string; releaseGeneration: number };
      if (auth.kind === 'api_key' && pinned.every((v) => v === undefined)) {
        const release = await effectiveApiRelease(ctx, {
          orgId,
          templateId: body.templateId,
          mode,
        });
        review = {
          templateVersion: release.version,
          releaseId: release.id,
          releaseGeneration: release.generation,
        };
      } else if (
        body.templateVersion === undefined ||
        body.releaseId === undefined ||
        body.releaseGeneration === undefined
      ) {
        throw new ValidationError('Review the mode and template version before issuing the pass.');
      } else {
        review = {
          templateVersion: body.templateVersion,
          releaseId: body.releaseId,
          releaseGeneration: body.releaseGeneration,
        };
      }
      const detail = await createPassIdempotent(
        ctx,
        {
          orgId,
          templateId: body.templateId,
          ...review,
          ...(body.identityId ? { identityId: body.identityId } : {}),
          input: body.input,
          holderEmail: body.holderEmail ?? null,
          externalId: body.externalId ?? null,
          ...(body.serial ? { serial: body.serial } : {}),
          connectionId: body.connectionId ?? null,
          externalRef: body.externalRef ?? null,
          sendEmail: body.sendEmail ?? false,
          source: 'manual',
          mode,
          execution: { kind: 'tenant', authority },
          actor: actorFor(c),
        },
        key,
        { serverResolvedRelease: pinned.every((v) => v === undefined) },
      );
      return c.json(detail, 201);
    },
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'patch',
      path: '/{id}',
      summary: 'Update a pass (If-Match: version)',
      params: IdParamSchema,
      body: UpdatePassSchema,
      response: PassDetailSchema,
    },
    async (c) => {
      const patch = c.req.valid('json');
      const expected = ifMatch(c);
      const ctx = svc(c);
      const id = c.req.valid('param').id;
      const { scope, authority } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
      const detail = await updatePass(ctx, actorFor(c), id, patch, {
        scope,
        authority,
        ...(expected !== undefined ? { ifMatch: expected } : {}),
      });
      return c.json(detail, 200, { etag: `"${detail.version}"` });
    },
  );
}
