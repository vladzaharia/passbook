import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { healHead } from '../retention/head-store.ts';
import { type PreparedReceipt, prepareReceipt, recordHead } from '../retention/receipt-service.ts';
import { chainHead } from '../retention/repo-receipts.ts';
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
const COUNTS_DAYS = 400;
const BATCH = 50;
/** Imports one run touches: the platform pass, then all org passes together. A backlog drains over several days. */
export const IMPORT_LIMITS = { platform: 150, orgs: 150 };

/** A grant refused because the import is already gone or already past the state the phase needs. */
export const isSettled = (error: unknown): boolean =>
  error instanceof AppError &&
  (error.code === 'IMPORT_STATE' ||
    error.code === 'IMPORT_NOT_FOUND' ||
    error.code === 'IMPORT_HELD');

type Page = (after: string, limit: number) => Promise<RetentionImport[]>;
interface Budget {
  left: number;
}

/** Runs `each` over a phase in bounded batches. A failed import is logged and skipped, never retried in the run. */
async function phase(
  ctx: ServiceContext,
  name: string,
  page: Page,
  each: (imp: RetentionImport) => Promise<void>,
  budget: Budget = { left: Number.POSITIVE_INFINITY },
): Promise<number> {
  let done = 0;
  let after = '';
  while (budget.left > 0) {
    const limit = Math.min(BATCH, budget.left);
    const imports = await page(after, limit);
    for (const imp of imports) {
      budget.left--;
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
    if (imports.length < limit || !last) break;
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
    (after, limit) => expiredDrafts(ctx.env.DB, now, after, limit),
    async (imp) => {
      await expireDraft(ctx, imp);
      await dropFile(ctx, imp);
    },
  );
  const targets = await retentionTargets(ctx, ['imports']);
  let cleared = 0;
  let deleted = 0;
  /** Every import commits with its own receipt, in one batch: no receipt, no delete. */
  const target = async (orgId: string | null, days: number, scope: Scope, budget: Budget) => {
    await healHead(ctx, orgId, 'imports', await chainHead(ctx.env.DB, orgId, 'imports'));
    const retire = async (
      policyDays: number,
      counts: { deleted: number; anonymised: number },
      commit: (receipt: PreparedReceipt) => Promise<void>,
    ) => {
      const receipt = await prepareReceipt(ctx, {
        orgId,
        cls: 'imports',
        kind: 'sweep',
        policyDays,
        cutoffAt: now - policyDays * DAY,
        ...counts,
      });
      await commit(receipt);
      await recordHead(ctx, receipt.receipt);
    };
    cleared += await phase(
      ctx,
      'clear',
      (after, limit) => importsWithPii(ctx.env.DB, now - days * DAY, after, limit, scope),
      (imp) => retire(days, { deleted: 0, anonymised: 1 }, (r) => clearPii(ctx, imp, r)),
      budget,
    );
    // The counts of an import are not the class value: their own receipt carries their own days.
    deleted += await phase(
      ctx,
      'delete',
      (after, limit) => oldImports(ctx.env.DB, now - COUNTS_DAYS * DAY, after, limit, scope),
      async (imp) => {
        await retire(COUNTS_DAYS, { deleted: 1, anonymised: 0 }, (r) => deleteImport(ctx, imp, r));
        await dropFile(ctx, imp);
      },
      budget,
    );
  };
  if (targets) {
    await target(
      null,
      targets.platform.imports,
      { kind: 'platform', exclude: targets.exclude },
      {
        left: IMPORT_LIMITS.platform,
      },
    );
    const budget = { left: IMPORT_LIMITS.orgs };
    let visited = 0;
    for (const o of targets.orgs) {
      if (budget.left <= 0) break;
      await target(o.orgId, o.days.imports, { kind: 'org', orgId: o.orgId }, budget);
      visited++;
    }
    await targets.finish(visited);
  }
  if (expired + cleared + deleted > 0)
    ctx.log.info('pass_import.retention', { expired, cleared, deleted });
}
