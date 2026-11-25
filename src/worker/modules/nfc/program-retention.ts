import { jobGrant } from '../../platform/authority.ts';
import { exists } from '../../platform/authority-cond.ts';
import { inList, lt, lte } from '../../platform/authority-expr.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { lapsedPrograms, purgeableProgramTenants } from './repo-programs-sweep.ts';

const DAY = 86_400_000;
/** Ended program rows are kept this long. A row that held keys goes only once the tag is reset or abandoned and 30 days old. */
export const PROGRAM_RETENTION_DAYS = 400;
const SWEEP_BATCH = 200;
const JOB = 'nfc.programs';

const grantFor = (ctx: ServiceContext, orgId: string, mode: 'live' | 'test') =>
  jobGrant(ctx, {
    purpose: 'org_mode.job.nfc.programs',
    job: JOB,
    orgId,
    mode,
    tables: ['nfc_tag_programs'],
  });

/**
 * Daily: a hold nobody ended is closed (to `interrupted` with its keys, else `failed`) and its session cleared,
 * then ended rows past retention are deleted. A row that holds keys is never deleted before it is reset or
 * abandoned (the migration's trigger refuses it).
 */
export async function sweepPrograms(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  let closed = 0;
  for (const row of await lapsedPrograms(ctx.env.DB, now, SWEEP_BATCH)) {
    const to = row.hasKeys ? 'interrupted' : 'failed';
    const g = grantFor(ctx, row.orgId, row.mode);
    g.update('nfc_tag_programs', {
      set: {
        state: to,
        step: 'auth',
        error_code: 'TAG_PROGRAM_EXPIRED',
        updated_at: now,
        sess_kek_version: null,
        sess_iv: null,
        sess_wrapped_dek: null,
        sess_ciphertext: null,
      },
      where: { id: row.id, state: inList(['started', 'scripted']), expires_at: lte(now) },
    });
    grantedAudit(
      g,
      ctx,
      {
        orgId: row.orgId,
        actorType: 'system',
        actorId: null,
        action: 'nfc_tag.program_failed',
        targetType: 'tag_program',
        targetId: row.id,
        detail: { hint: row.hint, code: 'TAG_PROGRAM_EXPIRED' },
      },
      [exists('nfc_tag_programs', { id: row.id, state: to })],
    );
    await g.commit();
    closed++;
  }
  const before = now - PROGRAM_RETENTION_DAYS * DAY;
  const tenants = await purgeableProgramTenants(ctx.env.DB, before);
  for (const t of tenants) {
    const g = grantFor(ctx, t.orgId, t.mode);
    g.delete('nfc_tag_programs', {
      where: { state: inList(['programmed', 'reset', 'abandoned']), updated_at: lt(before) },
    });
    g.delete('nfc_tag_programs', {
      where: { state: 'failed', kek_version: null, updated_at: lt(before) },
    });
    await g.commit();
  }
  ctx.log.info('nfc.program_retention', { closed, tenants: tenants.length });
}
