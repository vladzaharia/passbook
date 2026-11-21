import type { WalletProvider } from '../../../shared/contracts/wallet-providers.ts';
import { grant, grantedBatch } from '../../platform/authority.ts';
import { epochIs } from '../../platform/authority-checks.ts';
import { entitled } from '../../platform/authority-entitled.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import type { Actor } from '../../platform/context.ts';
import { ForbiddenError } from '../../platform/errors.ts';
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
import { clearSettingsCache } from '../settings/service.ts';
import type { planEnable } from '../wallet-providers/enrolment-service.ts';
import { addEnrolmentStep, ENROLMENT_TABLES } from '../wallet-providers/repo-enrolments.ts';
import { mapWalletWriteError } from '../wallet-providers/wallet-write-errors.ts';
import { collectSupersededBranding } from './branding-gc.ts';
import type { LoadedSetup } from './pass-setup-load.ts';
import type { SetupPlan } from './pass-setup-plan.ts';
import { requireOrg } from './service.ts';

export type Builder = Awaited<ReturnType<typeof planEnable>>;
const SETTING_COLUMNS = ['key', 'value', 'updated_by', 'updated_at'];
const SETTING_UPDATE = ['value', 'updated_by', 'updated_at'];

/** A refusal that says what the key lacks. */
export const lacks = (what: string) =>
  new ForbiddenError(`The API key needs ${what} for this change.`, 'MISSING_SCOPE');

export interface Applied {
  plan: SetupPlan;
  steps: Map<WalletProvider, Builder>;
  /** Only the wallet accounts change: no org row, no setting. */
  walletOnly: boolean;
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
  // The event names the key that made it; its audit row (migration 0181) says api_key.
  const actor =
    authority.kind === 'session'
      ? ({ type: 'user', id: authority.userId } as const)
      : ({ type: 'api_key', id: authority.keyId } as const);
  for (const step of steps.values()) addEnrolmentStep(ctx, g, step.build(actor));
  return g;
}

/**
 * Everything the save writes in one D1 transaction: the org row, its settings and one audit row under
 * `org.org.pass_setup_update`, and any enrolment under its own grant. The org grant holds the compare-and-set.
 * A brand:manage key's grant lists `orgs` only, so it cannot write a setting even if the service let it. A
 * wallet-only caller has no org grant: its audit row rides the enrolment grant.
 */
export async function commit(
  ctx: ServiceContext,
  actor: Actor,
  authority: TenantPassWrite,
  orgId: string,
  config: number,
  { plan, steps, walletOnly }: Applied,
  upserts: Record<string, unknown>,
  deletes: string[],
): Promise<void> {
  const now = ctx.clock.now();
  const by = actor.id;
  const audit = (g: Parameters<typeof grantedAudit>[0]) =>
    grantedAudit(g, ctx, {
      ...auditActor(actor),
      orgId,
      action: 'org.pass_setup_update',
      targetType: 'org',
      targetId: orgId,
      detail: {
        changes: Object.fromEntries(
          plan.diff.map((d) => [d.field, { from: d.before, to: d.after }]),
        ),
        ...(steps.size ? { enrolments: [...steps.keys()] } : {}),
      },
    });
  const wallet = steps.size ? enableGrant(ctx, authority, steps) : null;
  const grants = [];
  if (walletOnly) {
    if (!wallet) return;
    audit(wallet);
    grants.push(wallet);
  } else {
    const kitOnly = authority.kind === 'api_key' && authority.scope === 'brand:manage';
    if (kitOnly && (plan.name !== null || Object.keys(upserts).length || deletes.length))
      throw lacks('org:write');
    const g = grant(ctx, {
      purpose: 'org.org.pass_setup_update',
      principal: tenantPrincipal(authority),
      target: orgId,
      checks: [...capabilityChecks(authority), epochIs('orgs', orgId, 'config_revision', config)],
      codes: CODES,
      tables: kitOnly ? ['orgs'] : ['orgs', 'settings'],
    });
    if (plan.name !== null || plan.branding)
      g.update('orgs', {
        set: {
          ...(plan.name === null ? {} : { name: plan.name }),
          ...(plan.branding ? { branding: JSON.stringify(plan.branding) } : {}),
          // Live passes are rebuilt once the saves go quiet; the mark rides the same write.
          ...(plan.passLook ? { branding_dirty_at: now } : {}),
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
    audit(g);
    grants.push(g);
    if (wallet) grants.push(wallet);
  }
  try {
    await grantedBatch(ctx.env.DB, grants);
  } catch (error) {
    // Only an error that names the wallet is a wallet conflict; a settings or org refusal keeps its own.
    const text = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : '';
    throw steps.size && /wallet|enrolment/i.test(text) ? mapWalletWriteError(error) : error;
  }
}

/** Post-commit steps are best effort: the write is done, so a failure here is logged, never thrown. */
export async function afterCommit(
  ctx: ServiceContext,
  orgId: string,
  loaded: LoadedSetup,
  plan: SetupPlan,
): Promise<void> {
  clearSettingsCache(ctx.env.DB);
  try {
    const saved = await requireOrg(ctx, orgId);
    await collectSupersededBranding(ctx, orgId, JSON.stringify(loaded.branding), saved.branding);
  } catch (error) {
    ctx.log.error('pass_setup.gc_failed', { orgId, code: 'PASS_SETUP_GC', error });
  }
  if ('support.email' in plan.values) {
    const email = plan.values['support.email'];
    try {
      await syncReplyTo(ctx, orgId, typeof email === 'string' ? email : null);
    } catch (error) {
      ctx.log.error('pass_setup.reply_to_failed', { orgId, code: 'PASS_SETUP_REPLY_TO', error });
    }
  }
}
