import {
  DATA_CLASSES,
  RETENTION_CLASSES,
  type RetentionClass,
} from '../../../shared/privacy/data-classes.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  buildPlan,
  type OrgDecision,
  type PlatformPolicy,
  type Raw,
  type RetentionPlan,
  resolveOrg,
  resolvePlatform,
} from './policy.ts';
import { readOneOrg, readOrgRows, readPlatformRaw } from './repo.ts';

export const platformPolicyOf = (
  platform: ReadonlyMap<string, Raw>,
  cls: RetentionClass,
): PlatformPolicy =>
  resolvePlatform(cls, platform.get(DATA_CLASSES[cls].key), platform.get(DATA_CLASSES[cls].maxKey));

/**
 * What a retention job may delete today: the platform cutoff, orgs with their own cutoff, and orgs to leave
 * alone. A class whose platform value is invalid is blocked for everyone. Invalid values are logged, never defaulted.
 */
export async function retentionPlan(
  ctx: ServiceContext,
  cls: RetentionClass,
): Promise<RetentionPlan> {
  const now = ctx.clock.now();
  const platform = platformPolicyOf(await readPlatformRaw(ctx.env.DB), cls);
  const plan = buildPlan(
    cls,
    platform,
    platform.ok ? await readOrgRows(ctx.env.DB, cls, now) : [],
    now,
  );
  if (plan.blocked)
    ctx.log.error('retention.setting_invalid', { cls, code: 'RETENTION_SETTING_INVALID' });
  else
    for (const s of plan.skipped)
      if (s.reason === 'invalid')
        ctx.log.error('retention.setting_invalid', {
          orgId: s.orgId,
          cls,
          code: 'RETENTION_SETTING_INVALID',
        });
  return plan;
}

/**
 * One org, every class, as the about page and the summary show it. Not logged: a read, not a delete.
 * `showHeld` resolves the days a hold is suspending, because holds are not disclosed to holders.
 */
export async function orgRetention(
  ctx: ServiceContext,
  orgId: string,
  showHeld = false,
): Promise<Record<RetentionClass, OrgDecision | { kind: 'skip'; reason: 'platform_invalid' }>> {
  const now = ctx.clock.now();
  const [platformRaw, org] = await Promise.all([
    readPlatformRaw(ctx.env.DB),
    readOneOrg(ctx.env.DB, orgId, now),
  ]);
  const out = {} as Awaited<ReturnType<typeof orgRetention>>;
  for (const cls of RETENTION_CLASSES) {
    const platform = platformPolicyOf(platformRaw, cls);
    out[cls] = platform.ok
      ? resolveOrg({
          cls,
          platform,
          orgRaw: org.raw.get(cls),
          floor: org.floors.get(cls) ?? null,
          held: org.held && !showHeld,
          now,
        })
      : { kind: 'skip', reason: 'platform_invalid' };
  }
  return out;
}
