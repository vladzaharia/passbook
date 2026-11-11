import { jobGrant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { run } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import { createJobContext, type ServiceContext } from '../../platform/service-context.ts';
import { PassEmailIntentSchema } from './binding.ts';
import { passEmailOutput } from './repo-issuance-intent-fence.ts';
import { getOutbox } from './repo-outbox.ts';
import { beginProviderAttempt } from './repo-provider-attempt.ts';

/**
 * A queue-style context over a test kit: same env, clock and background collector, plus the job
 * brand. Mail without a captured principal acts as the system and needs it (jobGrant).
 */
export function jobCtxOf(kit: { ctx: ServiceContext }): ServiceContext {
  const { env, clock, log, waitUntil } = kit.ctx;
  return { ...createJobContext(env, 'test', { clock, log }), waitUntil };
}

/** The provider-boundary marker for a queued pass email, as `deliverEmail` writes it. */
export async function beginAttemptFor(
  ctx: ServiceContext,
  outboxId: string,
  lease: string,
  now: number,
): Promise<boolean> {
  const row = await getOutbox(ctx.env.DB, outboxId);
  const intent = PassEmailIntentSchema.parse(row?.payload.intent);
  const output = await passEmailOutput(ctx.env.DB, outboxId, intent, intent.pass);
  if (!row || !output) return false;
  return (
    (await beginProviderAttempt(ctx, {
      id: outboxId,
      lease,
      orgId: row.orgId,
      mode: intent.pass.mode,
      passId: intent.pass.passId,
      output,
      now,
    })) === 'started'
  );
}

/** A raw outbox row for tests of legacy and unbound shapes. */
export async function insertOutboxRaw(
  db: D1Database,
  row: {
    id: string;
    orgId: string;
    kind: 'push' | 'email';
    passId: string;
    coalesceKey: string | null;
    payload: Record<string, unknown>;
    now: number;
  },
): Promise<void> {
  await run(
    db,
    `INSERT OR IGNORE INTO outbox (id, org_id, kind, pass_id, coalesce_key, payload, state, available_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    [
      row.id,
      row.orgId,
      row.kind,
      row.passId,
      row.coalesceKey,
      JSON.stringify(row.payload),
      row.now,
    ],
  );
}

/** True when `checks` hold for a system actor of the org now: a grant with no writes that either commits or refuses. */
export async function checksHold(
  ctx: ServiceContext,
  o: { orgId: string; mode: 'live' | 'test'; checks: Check[] },
): Promise<boolean> {
  const g = jobGrant(ctx, {
    job: 'test',
    purpose: 'org_mode.job.checks_probe',
    orgId: o.orgId,
    mode: o.mode,
    checks: o.checks,
  });
  try {
    await g.commit();
    return true;
  } catch (error) {
    if (error instanceof AppError) return false;
    throw error;
  }
}
