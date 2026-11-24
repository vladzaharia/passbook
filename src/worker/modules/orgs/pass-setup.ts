import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import type { PassSetup } from '../../../shared/contracts/pass-setup.ts';
import { orgSetupChecks } from '../../../shared/org-setup-checks.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { modeOf } from '../../platform/auth.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from './access.ts';
import {
  type LoadedSetup,
  loadSetupFacts,
  type SetupCan,
  type SetupChange,
} from './pass-setup-load.ts';

/** What the caller holds, so `canChange` says what a save would be allowed to do. */
export async function setupCan(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
): Promise<SetupCan> {
  if (auth.kind === 'session') {
    const caps = (await getOrgAccess(ctx, auth.userId, orgId))?.capabilities ?? [];
    const has = (c: OrgCapability) => caps.includes(c);
    return {
      platform: auth.roles.includes('admin'),
      org: has('org:manage'),
      template: has('templates:publish'),
    };
  }
  const key = auth.kind === 'api_key' ? auth.scopes : [];
  // `brand:manage` changes the brand kit only, never a channel: Organization is `org:write`'s.
  return {
    platform: false,
    org: key.includes('org:write'),
    // Saving a template-level setting is a session's: a key holding templates:publish acts through the release flow only.
    template: false,
  };
}

export function viewOf(loaded: LoadedSetup, now: number): PassSetup {
  return { ...loaded.facts, checks: orgSetupChecks(loaded.facts, now) };
}

/** The org's brand, channels and accounts in the caller's mode, with the checks that apply. */
export async function getPassSetup(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  /** A save not yet written: the view as it would read after it (a dry run). */
  change?: SetupChange,
): Promise<{ view: PassSetup; loaded: LoadedSetup }> {
  const can = await setupCan(ctx, auth, orgId);
  const loaded = await loadSetupFacts(ctx, orgId, modeOf(auth), can, change);
  return { view: viewOf(loaded, ctx.clock.now()), loaded };
}
