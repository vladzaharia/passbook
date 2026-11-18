import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { writeReceipt } from '../retention/receipt-service.ts';
import type { Scope } from '../retention/repo-sweep.ts';
import { retentionTargets } from '../retention/targets.ts';
import {
  clearPii,
  deleteImport,
  expireDraft,
  expiredDrafts,
  importsWithPii,
  oldImports,
  type RetentionImport,
} from './repo-import-retention.ts';

const DAY = 86_400_000;
/** Cell values, emails and earlier values leave the rows this long after the import ended. */
export const PII_KEPT_MS = 30 * DAY;
/** The counts of an import stay this long. */
export const COUNTS_KEPT_MS = 400 * DAY;
const BATCH = 50;
const MAX_ROUNDS = 10;

/** A grant refused because the import is already gone or already past the state the phase needs. */
export const isSettled = (error: unknown): boolean =>
  error instanceof AppError && (error.code === 'IMPORT_STATE' || error.code === 'IMPORT_NOT_FOUND');

type Page = (after: string) => Promise<RetentionImport[]>;

/** Runs `each` over a phase in bounded batches. A failed import is logged and skipped, never retried in the run. */
async function phase(
  ctx: ServiceContext,
  name: string,
  page: Page,
  each: (imp: RetentionImport) => Promise<void>,
): Promise<number> {
  let done = 0;
  let after = '';
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const imports = await page(after);
    for (const imp of imports) {
      try {
        await each(imp);
        done++;
      } catch (error) {
        if (isSettled(error)) {
          // Another run (or a user) got there first: the work is done.
          ctx.log.info('pass_import.retention_settled', {
            orgId: imp.org_id,
            importId: imp.id,
            phase: name,
          });
          continue;
        }
        ctx.log.error(`pass_import.retention_${name}_failed`, {
          orgId: imp.org_id,
          importId: imp.id,
          code: 'IMPORT_RETENTION',
          error,
        });
      }
    }
    const last = imports[imports.length - 1];
    if (imports.length < BATCH || !last) break;
    after = last.id;
  }
  return done;
}

async function dropFile(ctx: ServiceContext, imp: RetentionImport): Promise<void> {
  if (!imp.object_key) return;
  try {
    await ctx.env.BUCKET.delete(imp.object_key);
  } catch (error) {
    ctx.log.error('pass_import.retention_file_failed', {
      orgId: imp.org_id,
      importId: imp.id,
      code: 'IMPORT_RETENTION_FILE',
      error,
    });
  }
}

/**
 * Daily: drafts past their 23 hours end `expired` and lose their file. Then, under the `imports` retention plan
 * (the org's days, floors, holds and the platform maximum), rows of imports that ended that many days ago lose
 * their cell values, emails and earlier values. Imports `COUNTS_KEPT_MS` old go with their counts; an org under
 * a hold keeps both. Each phase takes at most 500 imports per target a run, so a backlog drains over several days.
 */
export async function dailyImports(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  const expired = await phase(
    ctx,
    'expire',
    (after) => expiredDrafts(ctx.env.DB, now, after, BATCH),
    async (imp) => {
      await expireDraft(ctx, imp);
      await dropFile(ctx, imp);
    },
  );
  const targets = await retentionTargets(ctx, ['imports']);
  let cleared = 0;
  let deleted = 0;
  if (targets) {
    const run = async (orgId: string | null, days: number, scope: Scope) => {
      const c = await phase(
        ctx,
        'clear',
        (after) => importsWithPii(ctx.env.DB, now - days * DAY, after, BATCH, scope),
        (imp) => clearPii(ctx, imp),
      );
      const d = await phase(
        ctx,
        'delete',
        (after) => oldImports(ctx.env.DB, now - COUNTS_KEPT_MS, after, BATCH, scope),
        async (imp) => {
          await deleteImport(ctx, imp);
          await dropFile(ctx, imp);
        },
      );
      cleared += c;
      deleted += d;
      if (c + d > 0)
        await writeReceipt(ctx, {
          orgId,
          cls: 'imports',
          kind: 'sweep',
          policyDays: days,
          cutoffAt: now - days * DAY,
          deleted: d,
          anonymised: c,
        });
    };
    await run(null, targets.platform.imports, { kind: 'platform', exclude: targets.exclude });
    let visited = 0;
    for (const o of targets.orgs) {
      await run(o.orgId, o.days.imports, { kind: 'org', orgId: o.orgId });
      visited++;
    }
    await targets.finish(visited);
  }
  if (expired + cleared + deleted > 0)
    ctx.log.info('pass_import.retention', { expired, cleared, deleted });
}
