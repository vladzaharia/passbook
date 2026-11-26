import {
  SETUP_ACTIONS,
  type SetupActionKey,
  type SetupItem,
  type SetupItemKey,
} from '../../../shared/contracts/idp-setup.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { progressOf } from '../operations/progress.ts';
import type { Progress } from '../operations/progress-types.ts';
import { releaseLease } from '../operations/repo.ts';
import { idpClient } from './client.ts';
import { adminStill, held } from './ops-runs.ts';
import { blockError } from './setup-items.ts';
import { readSetup, type SetupView } from './setup-read.ts';
import { installToken } from './setup-token.ts';
import type { IdpRpc, SetupCtx } from './types.ts';

/** The steps after the read, in the matrix's order. */
const STEPS = [
  'groups',
  'client_groups',
  'client_restricted',
  'client_logo',
  'scim_token',
  'scim_provider',
  'scim_sync',
  'scim_mirror',
] as const;
type Step = (typeof STEPS)[number];

/** Polaris ID pushes on its own time: a step that waits for it looks again this often, and fails after. */
const WAIT_S = 30;
const GIVE_UP_MS = 10 * 60_000;

/** The target of a setup: `dry` or `live`, then `:` and the chosen items. */
export const setupTarget = (dryRun: boolean, items?: readonly SetupActionKey[]) => ({
  type: 'idp_setup',
  id: `${dryRun ? 'dry' : 'live'}${items?.length ? `:${[...items].sort().join('.')}` : ''}`,
});

function parseTarget(op: OperationDto): { dry: boolean; only: ReadonlySet<string> | null } {
  const [mode, list] = (op.target?.id ?? '').split(':');
  const items = list ? list.split('.') : null;
  if (
    op.target?.type !== 'idp_setup' ||
    (mode !== 'dry' && mode !== 'live') ||
    items?.some((i) => !(SETUP_ACTIONS as readonly string[]).includes(i))
  )
    throw new AppError('IDP_REFUSED', 403, 'This setup request is not valid.');
  // Minting the token is part of the connection: choosing one chooses both.
  const only = items?.flatMap((i) => (i === 'scim_provider' ? [i, 'scim_token'] : [i]));
  return { dry: mode === 'dry', only: only ? new Set(only) : null };
}

const itemOf = (view: SetupView, key: SetupItemKey): SetupItem => {
  const item = view.items.find((i) => i.key === key);
  if (!item) throw new AppError('IDP_APPLY_FAILED', 502, 'The setup read is incomplete.');
  return item;
};

/** Waits for Polaris ID: the run ends, a delayed job looks again, and after ten minutes the step fails. */
async function pause(
  ctx: ServiceContext,
  op: OperationDto,
  progress: Progress,
  lease: string,
  key: Step,
  giveUp: () => AppError,
): Promise<void> {
  const now = ctx.clock.now();
  if (now - (op.steps.find((s) => s.key === key)?.startedAt ?? now) > GIVE_UP_MS) throw giveUp();
  await progress.waiting(key, { until: now + WAIT_S * 1000, reason: 'Waiting for Polaris ID' });
  await releaseLease(ctx.env.DB, op.id, op.attempt, lease);
  await ctx.env.JOBS.send(
    { kind: 'operation.run', operationId: op.id, attempt: op.attempt },
    { delaySeconds: WAIT_S },
  );
}

const pushMissing = () => new AppError('IDP_SETUP_SCIM_PUSH', 409, 'No push arrived.');
const mirrorEmpty = () =>
  new AppError('IDP_SETUP_MIRROR_EMPTY', 409, 'No users or groups arrived.');

/**
 * Sets Polaris ID up item by item. Each step reads its item: done is skipped, blocked stops with the reason, needed
 * is acted on and read again. A dry run calls the binding with `dryRun: true` and writes nothing; an item behind a
 * missing earlier one is "after". Every step is safe to repeat, so a retry resumes at the first item not done.
 */
export async function setupRun(
  ctx: ServiceContext,
  op: OperationDto,
  lease: string,
): Promise<void> {
  const progress = progressOf(ctx, op.id, op.attempt, lease);
  await adminStill(ctx, op);
  const { dry, only } = parseTarget(op);
  const actorId = op.startedBy.id ?? '';
  const rpc: IdpRpc = idpClient(ctx.env, ctx.log);
  const setup = (): SetupCtx => ({
    ref: `setup-${op.id}`,
    reason: 'setup',
    actor: { kind: 'user', id: actorId },
    dryRun: dry,
  });
  const ids: Record<string, string> = { dryRun: dry ? 'yes' : 'no' };
  progress.step('check');
  let view = await readSetup(ctx, rpc);
  for (const key of ['binding', 'polaris_settings', 'client'] as const) {
    const item = itemOf(view, key);
    if (item.status === 'blocked') throw blockError(item);
  }
  await progress.step('check').done();
  const audit = (key: string, result: string) =>
    recordAudit(ctx, {
      actorType: 'user',
      actorId,
      action: `idp.setup.${key}`,
      targetType: 'idp',
      targetId: 'setup',
      detail: { item: key, result },
    });
  const act = async (key: Step): Promise<void> => {
    if (key === 'groups') await rpc.placeRoleGroups(setup());
    else if (key === 'client_groups')
      ids.allowed = String((await rpc.allowClientGroups(setup())).added);
    else if (key === 'client_restricted') await rpc.restrictClient(setup());
    else if (key === 'client_logo') await rpc.setClientLogo(setup());
    else if (key === 'scim_sync') await rpc.syncScim(setup());
    else if (key === 'scim_token' || key === 'scim_provider')
      await installToken(ctx, rpc, actorId, setup());
  };
  for (const key of STEPS) {
    await progress.checkCancel();
    await held(ctx, op, lease);
    const step = progress.step(key);
    const item = itemOf(view, key);
    if (item.status === 'done') {
      ids[key] = 'done';
      await step.skip();
      continue;
    }
    if (only && !only.has(key)) {
      ids[key] = 'skipped';
      await step.skip();
      continue;
    }
    // Reached only after a sync was seen: the copy may simply not have arrived yet.
    const copying = key === 'scim_mirror' && !item.reason?.startsWith('after:');
    if (item.status === 'blocked' && !copying) throw blockError(item);
    if (item.reason?.startsWith('after:')) {
      ids[key] = 'after';
      await step.skip();
      continue;
    }
    if (dry) {
      // A preview of the connection mints nothing and calls nothing: the matrix already says what is missing.
      if (key !== 'scim_token' && key !== 'scim_provider' && key !== 'scim_mirror') await act(key);
      ids[key] = 'would';
      await step.skip();
      continue;
    }
    const waited = op.steps.find((s) => s.key === key)?.state === 'waiting';
    if (!copying && !waited) {
      try {
        await act(key);
      } catch (error) {
        // The logo is a nicety: its failure does not stop the items after it.
        if (key !== 'client_logo' || !(error instanceof AppError)) throw error;
        ctx.log.warn('idp.setup.logo_failed', { code: error.code });
        ids[key] = 'failed';
        await step.skip();
        continue;
      }
    }
    view = await readSetup(ctx, rpc);
    if (itemOf(view, key).status !== 'done') {
      if (key !== 'scim_sync' && key !== 'scim_mirror')
        throw new AppError('IDP_APPLY_FAILED', 502, 'Polaris ID did not take the change.');
      await pause(ctx, op, progress, lease, key, key === 'scim_sync' ? pushMissing : mirrorEmpty);
      return;
    }
    if (key !== 'scim_mirror') await audit(key, 'changed');
    ids[key] = 'changed';
    await step.done();
  }
  await progress.succeed({ href: null, ids });
}
