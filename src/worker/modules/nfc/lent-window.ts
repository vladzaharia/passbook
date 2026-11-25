import type { JobOf } from '../../jobs/types.ts';
import { jobGrant } from '../../platform/authority.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { candidateById } from '../scan/repo-lookup.ts';
import { guestEnd } from './guest-end.ts';

const DAY_MS = 86_400_000;

interface Lent {
  id: string;
  mode: 'live' | 'test';
  bound_at: number;
  expires_at: number | null;
  binding_days: number | null;
}

const LENT_SQL = `SELECT b.id, t.mode, b.bound_at, b.expires_at, y.binding_days
  FROM tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id JOIN nfc_tag_types y ON y.id = t.type_id
  WHERE b.pass_id = ? AND b.scope = 'pass' AND b.ended_at IS NULL AND t.org_id = ? AND y.org_id = ? AND y.use = 'visitor'`;

/** Queues a recompute when the pass holds a lent tag; a pass without one costs one read. */
export async function queueLentWindow(
  ctx: ServiceContext,
  pass: { id: string; orgId: string },
): Promise<void> {
  const held = await first(ctx.env.DB, `${LENT_SQL} LIMIT 1`, [pass.id, pass.orgId, pass.orgId]);
  if (held)
    await ctx.env.JOBS.send({ kind: 'tags.lent_window', passId: pass.id, orgId: pass.orgId });
}

/**
 * Moves the expiry of a pass's active lent tags to its new window end, still capped by the type's
 * `binding_days` from the bind. A pass that left its guest plan keeps the expiry it had.
 */
export async function handleLentWindow(
  job: JobOf<'tags.lent_window'>,
  ctx: ServiceContext,
): Promise<void> {
  const candidate = await candidateById(ctx.env.DB, job.orgId, job.passId);
  const endsAt = candidate ? await guestEnd(ctx, job.orgId, candidate) : null;
  if (endsAt === null) return;
  const rows = await all<Lent>(ctx.env.DB, LENT_SQL, [job.passId, job.orgId, job.orgId]);
  for (const row of rows) {
    const byType = row.binding_days ? row.bound_at + row.binding_days * DAY_MS : endsAt;
    // expires_at must follow bound_at: a window shortened to before the bind lapses at once.
    const next = Math.max(Math.min(byType, endsAt), row.bound_at + 1);
    if (next === row.expires_at) continue;
    const g = jobGrant(ctx, {
      purpose: 'org_mode.job.nfc.lent_window',
      job: 'nfc.lent_window',
      orgId: job.orgId,
      mode: row.mode,
      tables: ['tag_bindings'],
    });
    g.joined('tag_bindings', {
      via: 'tag_id',
      where: { id: row.id, ended_at: null },
      set: { expires_at: next },
    });
    await g.commit();
  }
}
