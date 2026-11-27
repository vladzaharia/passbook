import type { PassSetupPatch, PassSetupResult } from '../../../shared/contracts/pass-setup.ts';
import { OrgSettingsSchema } from '../../../shared/contracts/settings.ts';
import type { WalletProvider } from '../../../shared/contracts/wallet-providers.ts';
import type { AuthContext } from '../../platform/auth.ts';
import type { Actor } from '../../platform/context.ts';
import { AppError, ConflictError, ForbiddenError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { checkValues } from '../settings/service.ts';
import { planEnable } from '../wallet-providers/enrolment-service.ts';
import { walletProviderEnabled } from '../wallet-providers/provider-policy.ts';
import { getOrgAccess } from './access.ts';
import { getPassSetup } from './pass-setup.ts';
import { afterCommit, type Builder, commit, lacks } from './pass-setup-commit.ts';
import { impactOf } from './pass-setup-impact.ts';
import type { LoadedSetup } from './pass-setup-load.ts';
import { planOf, touchesBeyondBrandKit } from './pass-setup-plan.ts';
import { resolveStaged } from './pass-setup-stage.ts';
import { assertSharedWrite } from './shared-write.ts';

const isEmpty = (patch: PassSetupPatch) =>
  Object.keys(patch.brand ?? {}).length === 0 && Object.keys(patch.channels ?? {}).length === 0;

/** Whether the caller holds `wallet:write` (a key) or `integrations:manage` (a member), which turning an enrolment on needs. */
async function holdsWalletWrite(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
): Promise<boolean> {
  if (auth.kind === 'session')
    return (
      (await getOrgAccess(ctx, auth.userId, orgId))?.capabilities.includes('integrations:manage') ??
      false
    );
  return auth.kind === 'api_key' && auth.scopes.includes('wallet:write');
}

/** The caller was admitted for the wallet accounts only: `integrations:manage` or a `wallet:write` key. */
const walletOnlyCaller = (authority: TenantPassWrite) =>
  authority.kind === 'session'
    ? authority.capability === 'integrations:manage'
    : authority.scope === 'wallet:write';

/** A body that only allows a wallet channel that is already allowed: it turns accounts on and writes no setting. */
function walletOnlyPatch(patch: PassSetupPatch, view: PassSetupView): boolean {
  const entries = Object.entries(patch.channels ?? {});
  return (
    patch.brand === undefined &&
    entries.length > 0 &&
    entries.every(
      ([channel, want]) =>
        (channel === 'google' || channel === 'samsung') &&
        want === 'allowed' &&
        view.channels[channel].allowed,
    )
  );
}

type PassSetupView = Awaited<ReturnType<typeof getPassSetup>>['view'];

/**
 * Enrolments the save would turn on: Allowed for a provider whose account is off and ready, in a released
 * mode. An account that is not ready is left as it is; the checks name what is missing.
 */
async function readyEnrolments(
  ctx: ServiceContext,
  orgId: string,
  patch: PassSetupPatch,
  view: PassSetupView,
  loaded: LoadedSetup,
): Promise<Map<WalletProvider, Builder>> {
  const out = new Map<WalletProvider, Builder>();
  for (const provider of ['google', 'samsung'] as const) {
    if (patch.channels?.[provider] !== 'allowed') continue;
    if (view.channels[provider].account?.state !== 'off') continue;
    if (!walletProviderEnabled(provider, view.mode)) continue;
    // The revision the client's view was read at, so a source changed since is not enabled unseen.
    const read = loaded.enrolments.find((r) => r.provider === provider)?.enrolment_revision ?? 0;
    try {
      out.set(provider, await planEnable(ctx, orgId, view.mode, provider, read));
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      // Not ready (plan, source, check, hold): the switch still turns on, the account stays off.
      ctx.log.info('pass_setup.enrolment_not_ready', { orgId, provider, code: error.code });
    }
  }
  return out;
}

/** A platform key (no org of its own) never changes an organization's setup. */
export function assertOrgBoundKey(authority: TenantPassWrite): void {
  if (authority.kind === 'api_key' && authority.keyOrgId === null)
    throw new ForbiddenError(
      'A platform key cannot change an organization setup.',
      'ORG_FORBIDDEN',
    );
}

/**
 * `PATCH /orgs/{orgId}/pass-setup`. A dry run answers with the view after the change, the diff and the impact,
 * and writes nothing. An apply writes the org row, its settings, the enrolment steps and one audit row in a
 * single grant batch; a stale revision is a 409 before it and a compare-and-set inside it.
 */
export async function patchPassSetup(
  ctx: ServiceContext,
  actor: Actor,
  auth: AuthContext,
  authority: TenantPassWrite,
  orgId: string,
  patch: PassSetupPatch,
  dryRun: boolean,
): Promise<PassSetupResult> {
  if (isEmpty(patch))
    throw new ValidationError('Send at least one change.', [], 'PASS_SETUP_EMPTY');
  if (authority.kind === 'api_key' && authority.keyOrgId === null)
    throw new ForbiddenError(
      'A platform key cannot change an organization setup.',
      'ORG_FORBIDDEN',
    );
  const walletOnly = walletOnlyCaller(authority);
  if (
    authority.kind === 'api_key' &&
    authority.scope === 'brand:manage' &&
    touchesBeyondBrandKit(patch)
  )
    throw lacks('org:write');
  // Only the wallet accounts are per mode: every other field is shared with Live.
  if (!walletOnly) await assertSharedWrite(ctx, authority, orgId, 'the brand kit or setup');
  const { view, loaded } = await getPassSetup(ctx, auth, orgId);
  if (patch.expectedRevision !== view.revision)
    throw new ConflictError('The setup changed. Reload and retry.', 'PASS_SETUP_CHANGED');
  if (walletOnly && !walletOnlyPatch(patch, view))
    throw authority.kind === 'api_key'
      ? lacks('org:write')
      : new ForbiddenError('Changing more than the wallet accounts needs organization access.');
  if (patch.brand?.mark && !view.brand.mark.allowed.includes(patch.brand.mark))
    throw new ForbiddenError('This plan does not include that setting.', 'BRAND_MARK_NOT_ALLOWED');

  const staged = patch.brand ? await resolveStaged(ctx, orgId, patch.brand, !dryRun) : {};
  const steps = await readyEnrolments(ctx, orgId, patch, view, loaded);
  if (steps.size > 0 && !(await holdsWalletWrite(ctx, auth, orgId)))
    throw authority.kind === 'api_key'
      ? lacks('wallet:write')
      : new ForbiddenError('Turning on a wallet account needs integrations access.');
  // The settings the plan is built from are the ones read with the revision: one snapshot.
  const settings = loaded.settings;
  const plan = planOf(patch, view, loaded.branding, settings, staged, new Set(steps.keys()));
  const { upserts, deletes } = await checkValues(ctx, `org:${orgId}`, plan.values);
  const impact = await impactOf(ctx, orgId, view.mode, view, plan);
  const { diff } = plan;
  if (dryRun) {
    // The same loader reads the saved state with the change laid over it, so the two views cannot drift.
    const next: Record<string, unknown> = { ...settings, ...upserts };
    for (const key of deletes) delete next[key];
    const after = await getPassSetup(ctx, auth, orgId, {
      ...(plan.name === null ? {} : { name: plan.name }),
      ...(plan.branding ? { branding: JSON.stringify(plan.branding) } : {}),
      settings: OrgSettingsSchema.parse(next),
      enable: plan.enable,
    });
    return { dryRun: true, view: after.view, diff, impact };
  }

  await commit(
    ctx,
    actor,
    authority,
    orgId,
    loaded.config,
    { plan, steps, walletOnly },
    upserts,
    deletes,
  );
  await afterCommit(ctx, orgId, loaded, plan);
  return { dryRun: false, view: (await getPassSetup(ctx, auth, orgId)).view, diff, impact };
}
