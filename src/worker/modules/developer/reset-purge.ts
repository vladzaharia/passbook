import type { ServiceContext } from '../../platform/service-context.ts';
import type { StepHandle } from '../operations/progress-types.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { deleteObjects, deletePassRows } from '../passes/repo-ops-retention.ts';
import { dropPrintPdfs } from '../prints/pdf-drop.ts';
import { prepareScanRetentionDelete } from '../scan/scan-retention-proof.ts';
import {
  claimStands,
  deleteSlice,
  importObjectKeys,
  type ResetTable,
  SLICE_ROWS,
  sandboxPasses,
} from './repo-reset.ts';

const PAGE = 25;

/** What one purge removed, and what it could not. */
export interface Tally {
  passes: number;
  kept: number;
  captures: number;
  calls: number;
  other: number;
}

export const emptyTally = (): Tally => ({ passes: 0, kept: 0, captures: 0, calls: 0, other: 0 });

/**
 * Test passes of the sandbox, a page at a time, each deleted by the guarded statement the daily test purge uses.
 * `step` counts every pass visited, kept ones too, so the bar ends full. `base` is what an earlier attempt did.
 * False when the claim stopped standing (a close or a newer reset): the purge ends there.
 */
export async function purgePasses(
  ctx: ServiceContext,
  sandbox: { orgId: string },
  userId: string,
  stamp: number,
  tally: Tally,
  step: StepHandle,
  base: number,
): Promise<boolean> {
  const keyset = await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  let after = '';
  for (;;) {
    // The claim is checked before every page: a close or a newer reset stops this one.
    if (!(await claimStands(ctx.env.DB, sandbox.orgId, userId, stamp))) return false;
    const passes = await sandboxPasses(ctx.env.DB, sandbox.orgId, after, PAGE);
    for (const pass of passes) {
      if (pass.mode !== 'test') {
        tally.kept++;
        continue;
      }
      const retention = await prepareScanRetentionDelete(ctx.env, pass);
      const removed = await deletePassRows(ctx.env.DB, pass, retention, keyset, {
        testBefore: stamp + 1,
        lifecycleGeneration: pass.lifecycleGeneration,
        claim: { userId, stamp },
      });
      if (!removed.deleted) {
        tally.kept++;
        continue;
      }
      await deleteObjects(ctx.env.BUCKET, removed.objectKeys);
      await dropPrintPdfs(ctx, pass);
      tally.passes++;
      await step.count(base + tally.passes);
    }
    const last = passes.at(-1);
    if (passes.length < PAGE || !last) return true;
    after = last.id;
  }
}

const TABLES: [ResetTable, keyof Tally][] = [
  ['captured_emails', 'other'],
  ['bundles', 'other'],
  ['pass_imports', 'other'],
  ['broadcasts', 'other'],
  ['message_rules', 'other'],
  ['request_log', 'calls'],
  ['idempotent_requests', 'other'],
  ['idempotency_keys', 'other'],
];

/** The rest of the Test data, table by table in slices: `step` counts the tables done ("3 of 8"). */
export const ROW_TABLES = TABLES.length;
export async function purgeRows(
  ctx: ServiceContext,
  orgId: string,
  userId: string,
  stamp: number,
  tally: Tally,
  step: StepHandle,
): Promise<void> {
  let done = 0;
  for (const [table, into] of TABLES) {
    // Import files go after their rows: those whose row is gone now (the others wait for a resume).
    const files =
      table === 'pass_imports' ? await importObjectKeys(ctx.env.DB, orgId, userId, stamp) : [];
    for (;;) {
      const n = await deleteSlice(ctx.env.DB, table, orgId, userId, stamp);
      tally[into] += n;
      if (n < SLICE_ROWS) break;
    }
    if (files.length > 0) {
      const left = new Set(await importObjectKeys(ctx.env.DB, orgId, userId, stamp));
      await deleteObjects(
        ctx.env.BUCKET,
        files.filter((k) => !left.has(k)),
      );
    }
    await step.count(++done);
  }
}
