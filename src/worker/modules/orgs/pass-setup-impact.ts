import type { Mode } from '../../../shared/contracts/common.ts';
import type { PassSetup, PassSetupImpact } from '../../../shared/contracts/pass-setup.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { SetupPlan } from './pass-setup-plan.ts';
import { countLivePasses } from './repo-branding.ts';
import { passesOnTemplates } from './repo-pass-setup.ts';

/** Who the save touches: passes rebuilt, passes that stop getting new copies, enrolments turned on. */
export async function impactOf(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  view: PassSetup,
  plan: SetupPlan,
): Promise<PassSetupImpact> {
  const db = ctx.env.DB;
  const stops = await Promise.all(
    plan.blocked.map(async (channel) => {
      const ids = view.templates.filter((t) => t.channels[channel].on).map((t) => t.id);
      return {
        channel,
        templates: ids.length,
        passes: ids.length ? await passesOnTemplates(db, orgId, mode, ids) : 0,
      };
    }),
  );
  return {
    passesToUpdate: plan.passLook ? await countLivePasses(db, orgId) : 0,
    channelStops: stops,
    enrolments: plan.enable,
  };
}
