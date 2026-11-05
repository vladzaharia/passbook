import {
  CreatePassSchema,
  IdParamSchema,
  PassDetailSchema,
  UpdatePassSchema,
} from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import { BadRequestError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { createPassIdempotent } from './create.ts';
import { actorFor, assertOrg, type C, passScopeOf, svc } from './http.ts';
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
      assertOrg(c, body.orgId);
      const key = c.req.header('idempotency-key')?.trim();
      if (key !== undefined && (key.length < 1 || key.length > 200))
        throw new BadRequestError(
          'Idempotency-Key must be 1 to 200 characters.',
          'IDEMPOTENCY_KEY_INVALID',
        );
      const detail = await createPassIdempotent(
        svc(c),
        {
          orgId: body.orgId,
          templateId: body.templateId,
          ...(body.templateVersion ? { templateVersion: body.templateVersion } : {}),
          ...(body.identityId ? { identityId: body.identityId } : {}),
          input: body.input,
          holderEmail: body.holderEmail ?? null,
          externalId: body.externalId ?? null,
          ...(body.serial ? { serial: body.serial } : {}),
          connectionId: body.connectionId ?? null,
          externalRef: body.externalRef ?? null,
          sendEmail: body.sendEmail ?? false,
          source: 'manual',
          mode: modeOf(c.var.auth),
          actor: actorFor(c),
        },
        key,
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
      const detail = await updatePass(svc(c), actorFor(c), c.req.valid('param').id, patch, {
        scope: passScopeOf(c),
        ...(expected !== undefined ? { ifMatch: expected } : {}),
      });
      return c.json(detail, 200, { etag: `"${detail.version}"` });
    },
  );
}
