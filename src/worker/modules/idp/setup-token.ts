import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { progressOf } from '../operations/progress.ts';
import { idpClient } from './client.ts';
import { adminStill, held } from './ops-runs.ts';
import { activateScimToken, hashScimToken, mintScimToken } from './scim-tokens.ts';
import { blockError } from './setup-items.ts';
import { readSetup } from './setup-read.ts';
import type { IdpRpc, SetupCtx } from './types.ts';

/** Who started the run: the audit actor and the binding's, one for a person and one for a Platform key. */
export function starterOf(op: OperationDto) {
  const id = op.startedBy.id ?? '';
  return op.startedBy.type === 'api_key'
    ? ({ id, audit: 'api_key', rpc: { kind: 'key', id } } as const)
    : ({ id, audit: 'user', rpc: { kind: 'user', id } } as const);
}

/** The rotation's target: `dry` or `live`. */
export const rotateTarget = (dryRun: boolean) => ({
  type: 'idp_scim_token',
  id: dryRun ? 'dry' : 'live',
});

/**
 * Mints a pending token, hands it to Polaris ID, reads back that Polaris ID holds that same token, and only then
 * makes it the active one. A false flip (the pending row expired or was retired) mints again once. The token
 * lives in this function and nowhere else: not in a row, a log or the operation.
 */
export async function installToken(
  ctx: ServiceContext,
  rpc: IdpRpc,
  actor: string,
  setup: SetupCtx,
  onConnected?: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { id, token } = await mintScimToken(ctx, actor);
    await rpc.ensureScim(token, setup);
    const seen = await rpc.setupStatus({ tokenHashes: [await hashScimToken(token)] });
    if (seen.scim.token !== 0)
      throw new AppError('IDP_APPLY_FAILED', 502, 'Polaris ID did not take the token.');
    await onConnected?.();
    if (await activateScimToken(ctx, id)) return;
  }
  throw new AppError('IDP_SETUP_TOKEN', 502, 'The SCIM token could not be switched.');
}

/**
 * Rotates the SCIM token: new token to Polaris ID first, then PassBook's receiver switches, so there is no gap
 * (the receiver accepts the pending token meanwhile). A dry run reads and writes nothing, and mints nothing.
 */
export async function rotateRun(
  ctx: ServiceContext,
  op: OperationDto,
  lease: string,
): Promise<void> {
  const progress = progressOf(ctx, op.id, op.attempt, lease);
  await adminStill(ctx, op);
  const dry = op.target?.id !== 'live';
  const rpc = idpClient(ctx.env, ctx.log);
  const { items, scimExists } = await readSetup(ctx, rpc);
  progress.step('token');
  for (const key of [
    'binding',
    'polaris_settings',
    'client',
    'client_restricted',
    'scim_provider',
  ]) {
    const item = items.find((i) => i.key === key);
    if (item?.status === 'blocked') throw blockError(item);
    if (key === 'client_restricted' && item?.status !== 'done')
      throw new AppError('IDP_CLIENT', 409, 'The app is not restricted yet.');
  }
  // Creating the connection is setup's job; a rotation only replaces the token of one that is there.
  if (!scimExists) throw new AppError('IDP_SCIM_MISSING', 404, 'No SCIM connection yet.');
  if (dry) {
    await progress.step('token').skip();
    await progress.step('switch').skip();
    await progress.succeed({ href: null, ids: { dryRun: 'yes', scim_token: 'would' } });
    return;
  }
  await held(ctx, op, lease);
  const setup: SetupCtx = {
    ref: `rotate-${op.id}`,
    reason: 'scim_rotate',
    actor: starterOf(op).rpc,
    dryRun: false,
  };
  await installToken(ctx, rpc, op.startedBy.id ?? '', setup, async () => {
    await progress.step('token').done();
    progress.step('switch');
  });
  await progress.step('switch').done();
  await progress.succeed({ href: null, ids: { dryRun: 'no', scim_token: 'rotated' } });
}
