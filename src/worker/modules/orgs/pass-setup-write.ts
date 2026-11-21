import type { PassSetupPatch, PassSetupResult } from '../../../shared/contracts/pass-setup.ts';
import { OrgSettingsSchema } from '../../../shared/contracts/settings.ts';
import type { WalletProvider } from '../../../shared/contracts/wallet-providers.ts';
import { scopeExercises } from '../../platform/api-scopes.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { grant, grantedBatch } from '../../platform/authority.ts';
import { epochIs } from '../../platform/authority-checks.ts';
import { entitled } from '../../platform/authority-entitled.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import type { Actor } from '../../platform/context.ts';
import { AppError, ConflictError, ForbiddenError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { auditActor } from '../audit/service.ts';
import { syncReplyTo } from '../delivery/reply-to.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import {
  capabilityChecks,
  keyScope,
  membershipCapability,
  tenantPrincipal,
} from '../passes/repo-authority.ts';
import { checkValues, clearSettingsCache, getOrgSettings } from '../settings/service.ts';
import { planEnable } from '../wallet-providers/enrolment-service.ts';
import { walletProviderEnabled } from '../wallet-providers/provider-policy.ts';
import { addEnrolmentStep, ENROLMENT_TABLES } from '../wallet-providers/repo-enrolments.ts';
import { mapWalletWriteError } from '../wallet-providers/wallet-write-errors.ts';
import { getOrgAccess } from './access.ts';
import { collectSupersededBranding } from './branding-gc.ts';
import { markPassesStale } from './branding-stale.ts';
import { getPassSetup } from './pass-setup.ts';
import { impactOf } from './pass-setup-impact.ts';
import { planOf, type SetupPlan, touchesBeyondBrandKit } from './pass-setup-plan.ts';
import { resolveStaged } from './pass-setup-stage.ts';
import { requireOrg } from './service.ts';

type Builder = Awaited<ReturnType<typeof planEnable>>;
const SETTING_COLUMNS = ['key', 'value', 'updated_by', 'updated_at'];
const SETTING_UPDATE = ['value', 'updated_by', 'updated_at'];

const isEmpty = (patch: PassSetupPatch) =>
  Object.keys(patch.brand ?? {}).length === 0 && Object.keys(patch.channels ?? {}).length === 0;

/** Whether the caller also holds `integrations:manage`, which turning an enrolment on needs. */
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
  return (
    auth.kind === 'api_key' && auth.scopes.some((s) => scopeExercises(s, 'integrations:manage'))
  );
}

/**
 * Enrolments the save would turn on: Allowed for a provider whose account is off and ready, in a released
 * mode. An account that is not ready is left as it is; the checks name what is missing.
 */
async function readyEnrolments(
  ctx: ServiceContext,
  orgId: string,
  patch: PassSetupPatch,
  view: Awaited<ReturnType<typeof getPassSetup>>['view'],
): Promise<Map<WalletProvider, Builder>> {
  const out = new Map<WalletProvider, Builder>();
  for (const provider of ['google', 'samsung'] as const) {
    if (patch.channels?.[provider] !== 'allowed') continue;
    if (view.channels[provider].account?.state !== 'off') continue;
    if (!walletProviderEnabled(provider, view.mode)) continue;
    try {
      out.set(provider, await planEnable(ctx, orgId, view.mode, provider));
    } catch (error) {
      // Not ready (plan, source, check, hold): the switch still turns on, the account stays off.
      if (!(error instanceof AppError)) throw error;
    }
  }
  return out;
}

/** A refusal that says what the key lacks. */
const lacks = (what: string) =>
  new ForbiddenError(`The API key needs ${what} for this change.`, 'MISSING_SCOPE');

interface Applied {
  plan: SetupPlan;
  steps: Map<WalletProvider, Builder>;
}

const CODES = { config: 'PASS_SETUP_CHANGED' };

/** The enrolment's own grant: its event is written under the enable purpose, which a trigger requires. */
function enableGrant(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  steps: ReadonlyMap<WalletProvider, Builder>,
) {
  const g = grant(ctx, {
    purpose: 'org_mode.wallet.enrolment_enable',
    principal: tenantPrincipal(authority),
    checks: [
      authority.kind === 'session'
        ? membershipCapability(authority.membershipId, 'integrations:manage')
        : keyScope(authority.keyId, 'wallet:write'),
      ...[...steps.values()].map((s) => entitled(s.feature)),
    ],
    codes: CODES,
    tables: ENROLMENT_TABLES,
  });
  // A key's step is the system's: the event has no key column, and the audit row names the key.
  const actor =
    authority.kind === 'session'
      ? ({ type: 'user', id: authority.userId } as const)
      : ({ type: 'system', id: null } as const);
  for (const step of steps.values()) addEnrolmentStep(ctx, g, step.build(actor));
  return g;
}

/**
 * Everything the save writes in one D1 transaction: the org row, its settings and one audit row under
 * `org.org.pass_setup_update`, and any enrolment under its own grant. The org grant holds the compare-and-set.
 */
async function commit(
  ctx: ServiceContext,
  actor: Actor,
  authority: TenantPassWrite,
  orgId: string,
  config: number,
  { plan, steps }: Applied,
  upserts: Record<string, unknown>,
  deletes: string[],
): Promise<void> {
  const now = ctx.clock.now();
  const by = actor.id;
  const g = grant(ctx, {
    purpose: 'org.org.pass_setup_update',
    principal: tenantPrincipal(authority),
    target: orgId,
    checks: [...capabilityChecks(authority), epochIs('orgs', orgId, 'config_revision', config)],
    codes: CODES,
    tables: ['orgs', 'settings'],
  });
  if (plan.name !== null || plan.branding)
    g.update('orgs', {
      set: {
        ...(plan.name === null ? {} : { name: plan.name }),
        ...(plan.branding ? { branding: JSON.stringify(plan.branding) } : {}),
        updated_at: maxNow(now),
      },
      where: {},
      returning: ['id'],
    });
  for (const [key, value] of Object.entries(upserts))
    g.upsert('settings', SETTING_COLUMNS, [key, JSON.stringify(value), by, now], {
      update: SETTING_UPDATE,
    });
  for (const key of deletes) g.delete('settings', { where: { key } });
  grantedAudit(g, ctx, {
    ...auditActor(actor),
    orgId,
    action: 'org.pass_setup_update',
    targetType: 'org',
    targetId: orgId,
    detail: {
      changes: Object.fromEntries(plan.diff.map((d) => [d.field, { from: d.before, to: d.after }])),
      ...(steps.size ? { enrolments: [...steps.keys()] } : {}),
    },
  });
  try {
    await grantedBatch(ctx.env.DB, steps.size ? [g, enableGrant(ctx, authority, steps)] : [g]);
  } catch (error) {
    // Only an enrolment step has the wallet conflicts; a settings or org refusal keeps its own error.
    throw steps.size ? mapWalletWriteError(error) : error;
  }
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
  if (
    authority.kind === 'api_key' &&
    authority.scope === 'brand:manage' &&
    touchesBeyondBrandKit(patch)
  )
    throw lacks('org:write');
  const { view, loaded } = await getPassSetup(ctx, auth, orgId);
  if (patch.expectedRevision !== view.revision)
    throw new ConflictError('The setup changed. Reload and retry.', 'PASS_SETUP_CHANGED');
  if (patch.brand?.mark && !view.brand.mark.allowed.includes(patch.brand.mark))
    throw new ForbiddenError('This plan does not include that setting.', 'BRAND_MARK_NOT_ALLOWED');

  const staged = patch.brand ? await resolveStaged(ctx, orgId, patch.brand, !dryRun) : {};
  const steps = await readyEnrolments(ctx, orgId, patch, view);
  if (steps.size > 0 && !(await holdsWalletWrite(ctx, auth, orgId)))
    throw authority.kind === 'api_key'
      ? lacks('wallet:write')
      : new ForbiddenError('Turning on a wallet account needs integrations access.');
  const settings = await getOrgSettings(ctx, orgId);
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

  await commit(ctx, actor, authority, orgId, loaded.config, { plan, steps }, upserts, deletes);
  clearSettingsCache(ctx.env.DB);
  const saved = await requireOrg(ctx, orgId);
  await collectSupersededBranding(ctx, orgId, JSON.stringify(loaded.branding), saved.branding);
  await markPassesStale(
    ctx,
    orgId,
    { name: view.brand.name.value ?? saved.name, branding: JSON.stringify(loaded.branding) },
    saved,
  );
  if ('support.email' in plan.values) {
    const email = plan.values['support.email'];
    await syncReplyTo(ctx, orgId, typeof email === 'string' ? email : null);
  }
  return { dryRun: false, view: (await getPassSetup(ctx, auth, orgId)).view, diff, impact };
}
