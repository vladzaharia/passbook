import type { z } from 'zod';
import type { BindPassConnectionSchema } from '../../../shared/contracts/index.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { detailOf } from './detail.ts';
import {
  connectionInOrg,
  type FieldSources,
  findByConnectionRef,
  getPass,
  setBinding,
} from './repo.ts';
import { type Actor, requestRefresh } from './service.ts';

const refTaken = () =>
  new ConflictError('That connection ref already has a pass.', 'PASS_REF_TAKEN');

/** Binds (or, with nulls, unbinds) an existing pass to an upstream ref, then queues a refresh. */
export async function bindPassConnection(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  body: z.infer<typeof BindPassConnectionSchema>,
  scope: string | null,
) {
  const db = ctx.env.DB;
  const pass = await getPass(db, passId, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const { connectionId, externalRef } = body;
  let fieldSources: FieldSources = pass.fieldSources;
  if (connectionId !== null && externalRef !== null) {
    if (!(await connectionInOrg(db, connectionId, pass.orgId)))
      throw new ValidationError(
        'The connection does not belong to this organization.',
        [],
        'CONNECTION_ORG',
      );
    const holder = await findByConnectionRef(db, pass.orgId, connectionId, externalRef);
    if (holder && holder !== pass.id) throw refTaken();
    const owned: FieldSources = Object.fromEntries(
      Object.keys(pass.personalization).map((k) => [k, 'connection' as const]),
    );
    // Default: the connection takes over every field. false keeps the current sources.
    fieldSources = body.resetFieldSources === false ? { ...owned, ...pass.fieldSources } : owned;
  }
  try {
    await setBinding(db, pass.id, { connectionId, externalRef, fieldSources });
  } catch (error) {
    const info = classifyD1Error(error);
    if (info?.kind === 'unique' && /passes\.external_ref/.test(info.detail)) throw refTaken();
    throw error;
  }
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: connectionId ? 'pass.bind' : 'pass.unbind',
    targetType: 'pass',
    targetId: pass.id,
    detail: { connectionId, externalRef },
  });
  if (connectionId) await requestRefresh(ctx, pass.id, actor);
  return detailOf(ctx, (await getPass(db, pass.id)) ?? pass);
}
