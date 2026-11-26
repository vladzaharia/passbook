import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgRow } from '../orgs/repo.ts';
import { passTypeOf } from './handles.ts';
import { auditOnce, loadRun, patchRef } from './provision-run.ts';
import { getIdentityRow } from './repo.ts';
import { setAscPassTypeId } from './repo-provision.ts';

/** Records the pass type Apple has, found or created, and audits it: the handle is reserved for this org, so a found one is ours. */
export async function recordPassType(
  ctx: ServiceContext,
  runId: string,
  passType: { ascId: string },
  outcome: 'found' | 'created' = 'found',
): Promise<void> {
  const loaded = await loadRun(ctx, runId);
  await patchRef(ctx, runId, { ascPassTypeId: passType.ascId });
  if (loaded.run.kind === 'rotate') {
    await setAscPassTypeId(ctx.env.DB, loaded.run.target_id, passType.ascId);
    return;
  }
  await auditOnce(
    ctx,
    loaded,
    'identity.pass_type_created',
    { passTypeIdentifier: passTypeOf(loaded.ref.handle ?? ''), outcome },
    null,
  );
}

export async function identifierOf(ctx: ServiceContext, identityId: string): Promise<string> {
  const row = await getIdentityRow(ctx.env.DB, identityId);
  if (!row) throw new NotFoundError('Signing identity not found.', 'IDENTITY_NOT_FOUND');
  return row.pass_type_identifier;
}

export async function orgNameOf(ctx: ServiceContext, orgId: string): Promise<string> {
  const org = await getOrgRow(ctx.env.DB, orgId);
  if (!org) throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  return org.name;
}
