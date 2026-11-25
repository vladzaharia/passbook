import { jobGrant } from '../../platform/authority.ts';
import { exists } from '../../platform/authority-cond.ts';
import { lt, lte, ne } from '../../platform/authority-expr.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { sweepPrograms } from './program-retention.ts';
import { lapsedEnrollments, purgeableEnrollmentTenants } from './repo-enrollments.ts';

const DAY = 86_400_000;
/** Finished requests are kept this long; a request names the admin who made it. */
export const ENROLLMENT_RETENTION_DAYS = 400;
const SWEEP_BATCH = 200;
const JOB = 'nfc.enrollments';

const grantFor = (ctx: ServiceContext, orgId: string, mode: 'live' | 'test') =>
  jobGrant(ctx, {
    purpose: 'org_mode.job.nfc.enrollments',
    job: JOB,
    orgId,
    mode,
    tables: ['tag_enrollments'],
  });

/** Daily: lapsed pending requests are expired and audited as the system, then old finished ones are deleted. */
export async function sweepEnrollments(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  let expired = 0;
  for (const row of await lapsedEnrollments(ctx.env.DB, now, SWEEP_BATCH)) {
    const g = grantFor(ctx, row.orgId, row.mode);
    g.update('tag_enrollments', {
      set: { state: 'expired', ended_at: row.expiresAt },
      where: { id: row.id, state: 'pending', expires_at: lte(now) },
    });
    grantedAudit(
      g,
      ctx,
      {
        orgId: row.orgId,
        actorType: 'system',
        actorId: null,
        action: 'tag.enroll.expire',
        targetType: 'enrollment',
        targetId: row.id,
        detail: { passId: row.passId, scannerId: row.scannerId },
      },
      [exists('tag_enrollments', { id: row.id, state: 'expired' })],
    );
    await g.commit();
    expired++;
  }
  const before = now - ENROLLMENT_RETENTION_DAYS * DAY;
  const tenants = await purgeableEnrollmentTenants(ctx.env.DB, before);
  for (const t of tenants) {
    const g = grantFor(ctx, t.orgId, t.mode);
    g.delete('tag_enrollments', { where: { state: ne('pending'), ended_at: lt(before) } });
    await g.commit();
  }
  ctx.log.info('tags.enrollment_retention', { expired, tenants: tenants.length });
  await sweepPrograms(ctx);
}
