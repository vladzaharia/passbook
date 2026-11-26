import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { healHead } from '../retention/head-store.ts';
import { prepareReceipt, recordHead } from '../retention/receipt-service.ts';
import { chainHead } from '../retention/repo-receipts.ts';
import type { Scope } from '../retention/repo-sweep.ts';
import { retentionTargets } from '../retention/targets.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';
import { deleteFileObjects, listFileIds } from './files-store.ts';
import {
  deleteEnded,
  deleteSuperseded,
  endedBefore,
  endUnfinished,
  idsWithRows,
  type RetentionFile,
  supersededDue,
  unfinishedDue,
} from './repo-files-retention.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const BATCH = 50;
/** Rows of an upload that ended unbound stay this long, so the UI can say it expired. */
const ENDED_KEPT_MS = 7 * DAY;
/** Files one run touches per phase; a backlog drains over several days. */
export const FILE_LIMITS = { unfinished: 500, ended: 500, platform: 150, orgs: 150 };
const ORPHAN_PAGE = 1000;
/** Listing pages one run reads: a bound on objects, so a large bucket is walked over several days. */
const ORPHAN_PAGES = 3;
const ORPHAN_CURSOR = 'retention.cursor:connection-files';
/** An object this young may belong to an upload whose row is not written yet. */
const ORPHAN_AGE_MS = HOUR;
const IMPORTS = 'imports';

type Page = (after: string, limit: number) => Promise<RetentionFile[]>;
interface Budget {
  left: number;
}

/** Runs `each` over a phase in bounded batches. A file that fails is logged and left for the next run. */
async function phase(
  ctx: ServiceContext,
  name: string,
  page: Page,
  each: (f: RetentionFile) => Promise<void>,
  budget: Budget,
): Promise<number> {
  let done = 0;
  let after = '';
  while (budget.left > 0) {
    const limit = Math.min(BATCH, budget.left);
    const files = await page(after, limit);
    for (const f of files) {
      budget.left--;
      try {
        await each(f);
        done++;
      } catch (error) {
        // A refusal means another run or a user got there first.
        ctx.log.error(`connection_file.retention_${name}_failed`, {
          orgId: f.org_id,
          code: error instanceof AppError ? error.code : 'FILE_RETENTION',
        });
      }
    }
    const last = files[files.length - 1];
    if (files.length < limit || !last) break;
    after = last.id;
  }
  return done;
}

/** Rows were committed first; a failed delete here leaves objects the orphan sweep removes. */
async function dropObjects(ctx: ServiceContext, f: RetentionFile): Promise<void> {
  try {
    await deleteFileObjects(ctx, f.org_id, f.id);
  } catch (error) {
    ctx.log.error('connection_file.retention_objects_failed', {
      orgId: f.org_id,
      code: 'FILE_RETENTION_OBJECTS',
      error,
    });
  }
}

/** Newest upload time among all objects of one file (a listing page may have split it). */
async function newestOf(ctx: ServiceContext, orgId: string, fileId: string): Promise<number> {
  let newest = 0;
  let cursor: string | undefined;
  do {
    const page = await ctx.env.BUCKET.list({
      prefix: `uploads/connection-files/${orgId}/${fileId}/`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const o of page.objects) newest = Math.max(newest, o.uploaded.getTime());
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return newest;
}

/**
 * Objects with no row, whose newest object is over an hour old: left by a crash between the two deletes. Walks
 * the bucket by a stored cursor, a few pages a run. A file a page boundary split is measured over all of its
 * objects before it is judged, so an upload in flight is never taken for an orphan.
 */
export async function sweepOrphans(ctx: ServiceContext): Promise<number> {
  const stored = await readSystemValue(ctx.env.DB, ORPHAN_CURSOR);
  let cursor = typeof stored === 'string' ? stored : undefined;
  const cutoff = ctx.clock.now() - ORPHAN_AGE_MS;
  let removed = 0;
  for (let page = 0; page < ORPHAN_PAGES; page++) {
    const listed = await listFileIds(ctx, cursor, ORPHAN_PAGE);
    const known = await idsWithRows(
      ctx.env.DB,
      listed.files.map((f) => f.fileId),
    );
    for (const f of listed.files) {
      if (known.has(f.fileId) || f.newest > cutoff) continue;
      if ((await newestOf(ctx, f.orgId, f.fileId)) > cutoff) continue;
      await deleteFileObjects(ctx, f.orgId, f.fileId);
      removed++;
    }
    cursor = listed.cursor;
    if (!cursor) break;
  }
  await writeSystemValue(ctx.env.DB, ORPHAN_CURSOR, cursor ?? null, ctx.clock.now());
  return removed;
}

/**
 * Daily. Drafts and pending revisions past 23 hours end and lose their objects. Superseded revisions beyond the
 * newest two, or older than the org's `imports` days, leave with a retention receipt in the same batch. Rows of
 * uploads that ended unbound go a week later. Objects always follow their rows.
 */
export async function dailyConnectionFiles(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  const ended = await phase(
    ctx,
    'expire',
    (after, limit) => unfinishedDue(ctx.env.DB, now, after, limit),
    async (f) => {
      await endUnfinished(ctx, f, now);
      await dropObjects(ctx, f);
    },
    { left: FILE_LIMITS.unfinished },
  );
  const targets = await retentionTargets(ctx, [IMPORTS]);
  let retired = 0;
  const target = async (orgId: string | null, days: number, scope: Scope, budget: Budget) => {
    await healHead(ctx, orgId, IMPORTS, await chainHead(ctx.env.DB, orgId, IMPORTS));
    retired += await phase(
      ctx,
      'retire',
      (after, limit) => supersededDue(ctx.env.DB, now - days * DAY, after, limit, scope),
      async (f) => {
        const receipt = await prepareReceipt(ctx, {
          orgId,
          cls: IMPORTS,
          kind: 'sweep',
          policyDays: days,
          cutoffAt: now - days * DAY,
          deleted: 1,
        });
        await deleteSuperseded(ctx, f, receipt);
        await recordHead(ctx, receipt.receipt);
        await dropObjects(ctx, f);
      },
      budget,
    );
  };
  if (targets) {
    await target(
      null,
      targets.platform[IMPORTS],
      { kind: 'platform', exclude: targets.exclude },
      { left: FILE_LIMITS.platform },
    );
    const budget = { left: FILE_LIMITS.orgs };
    let visited = 0;
    for (const o of targets.orgs) {
      if (budget.left <= 0) break;
      try {
        await target(o.orgId, o.days[IMPORTS], { kind: 'org', orgId: o.orgId }, budget);
      } catch (error) {
        ctx.log.error('connection_file.retention_org_failed', {
          orgId: o.orgId,
          code: 'FILE_RETENTION',
          error,
        });
      }
      visited++;
    }
    await targets.finish(visited);
  }
  const cleared = await phase(
    ctx,
    'clear',
    (after, limit) => endedBefore(ctx.env.DB, now - ENDED_KEPT_MS, after, limit),
    (f) => deleteEnded(ctx, f),
    { left: FILE_LIMITS.ended },
  );
  const orphans = await sweepOrphans(ctx);
  if (ended + retired + cleared + orphans > 0)
    ctx.log.info('connection_file.retention', { ended, retired, cleared, orphans });
}
