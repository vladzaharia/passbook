import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { devicePassEnabled } from './device-pass-identity.ts';
import { pushDevicePass } from './device-pass-push.ts';
import {
  bumpForPass,
  endDevicePass,
  expireDue,
  purgeEnded,
  staleOpenPasses,
} from './repo-device-pass.ts';

const DAY = 86_400_000;
const BATCH = 100;

/**
 * The source pass moved to `version` (a PATCH, a release rolling out to it, a refresh, stamps or a channel
 * change: every publish ends in `completePublishAttempt`). Its open device passes stand for the new version and
 * their phones are told. A no-op, with no query, while device passes are off.
 */
export async function syncDevicePasses(
  ctx: ServiceContext,
  pass: { id: string; mode: string; version: number },
): Promise<void> {
  if (!devicePassEnabled(ctx.env) || pass.mode !== 'test') return;
  try {
    const moved = await bumpForPass(ctx.env.DB, pass.id, pass.version, ctx.clock.now());
    for (const { id } of moved) await pushDevicePass(ctx, id);
  } catch (error) {
    ctx.log.error('device_pass.sync_failed', {
      code: 'DEVICE_PASS_SYNC_FAILED',
      passId: pass.id,
      error,
    });
  }
}

const system = { actorType: 'system', actorId: null } as const;

/**
 * Every 5 minutes: ends passes past their 24 hours (the phone is told, and then gets the voided copy), ends
 * those whose source pass was voided, removed or deleted, catches up any version the publish hook missed, and
 * purges rows 30 days after they ended.
 */
export async function sweepDevicePasses(ctx: ServiceContext): Promise<void> {
  if (!devicePassEnabled(ctx.env)) return;
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  for (const row of await expireDue(db, now, BATCH)) {
    await recordAudit(ctx, {
      ...system,
      orgId: row.org_id,
      action: 'device_pass.expired',
      targetType: 'device_pass',
      targetId: row.id,
      detail: {},
    });
    await pushDevicePass(ctx, row.id);
  }
  for (const stale of await staleOpenPasses(db, BATCH)) {
    if (stale.gone) {
      const ended = await endDevicePass(db, stale.id, 'pass_gone', now);
      if (!ended) continue;
      await recordAudit(ctx, {
        ...system,
        orgId: ended.org_id,
        action: 'device_pass.voided',
        targetType: 'device_pass',
        targetId: ended.id,
        detail: { reason: 'pass_gone' },
      });
      await pushDevicePass(ctx, stale.id);
    } else await syncDevicePasses(ctx, { id: stale.pass_id, mode: 'test', version: stale.version });
  }
  await purgeEnded(db, now - 30 * DAY, BATCH);
}

/** The minute cron: the sweep runs on every fifth minute. */
export async function cronDevicePasses(ctx: ServiceContext): Promise<void> {
  if (Math.floor(ctx.clock.now() / 60_000) % 5 === 0) await sweepDevicePasses(ctx);
}
