import type { z } from 'zod';
import { ScanReasonSchema } from '../../../shared/contracts/scan.ts';
import type {
  ScanRecentSchema,
  ScanSummarySchema,
} from '../../../shared/contracts/scan-session.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { actorCsrfFence } from './actor-csrf.ts';
import { credentialKeysetContext } from './credential-keyset-authority.ts';
import type { ScanActor } from './guard.ts';
import { historyEvidence, verifiedHistoryRows } from './history-evidence.ts';
import { historyProofPolicySources } from './history-proof.ts';
import { undoWindowMinutes } from './outcome.ts';
import type { HistoryProofFence, VerifiedHistoryProof } from './repo-history-proof-cas.ts';
import {
  type HistoryCsrfFence,
  historyEventSnapshots,
  historyProofFenceStmts,
  type RecentRow,
  recentScans,
  recentScansStmt,
  type SummaryActionCount,
  type SummaryTotals,
  summaryActionCountsStmt,
  summaryCandidateReader,
  summaryTotalsStmt,
} from './repo-scan-history.ts';
import type { HistoryEventSnapshot } from './repo-session-authority.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';

const DAY = 86_400_000;
const MINUTE = 60_000;

/** Compare the selected scan row while allowing its current policy to disappear. */
function sameHistorySnapshot(first: RecentRow, last: RecentRow): boolean {
  const original = first as unknown as Record<string, unknown>;
  const current = last as unknown as Record<string, unknown>;
  const keys = Object.keys(original);
  return (
    keys.length === Object.keys(current).length &&
    keys.every(
      (key) =>
        key === 'projection_authorized' ||
        (Object.hasOwn(current, key) && Object.is(original[key], current[key])),
    )
  );
}

/** The proof CAS statements and final actor/assignment SELECT run in one D1 transaction. */
async function finalHistoryRead<T>(
  ctx: ServiceContext,
  actor: ScanActor,
  events: readonly HistoryEventSnapshot[],
  csrf: HistoryCsrfFence,
  proofs: readonly VerifiedHistoryProof[],
  makeFinal: (now: number) => D1PreparedStatement,
): Promise<{ rows: T[]; proven: Set<string> }> {
  const now = ctx.clock.now();
  const fences = historyProofFenceStmts(ctx.env.DB, actor, now, events, [proofs], csrf);
  const results = await ctx.env.DB.batch([
    makeFinal(now),
    ...fences.map((entry) => entry.statement),
  ]);
  const proven = new Set(verifiedHistoryRows(fences, results.slice(1)).keys());
  return { rows: (results[0]?.results ?? []) as T[], proven };
}

/** `GET /scans`: current actor-owned history, with unavailable policy reduced to a receipt. */
export async function recentFor(
  ctx: ServiceContext,
  actor: ScanActor,
  limit: number,
): Promise<z.infer<typeof ScanRecentSchema>> {
  ctx = credentialKeysetContext(ctx);
  actor = cloneObservedScanActor(actor);
  const csrf = await actorCsrfFence(ctx, actor);
  if (!csrf) return { items: [] };
  const now = ctx.clock.now();
  const events = await historyEventSnapshots(ctx.env.DB, actor);
  const rows = await recentScans(ctx.env.DB, actor, limit, now, events, csrf);
  const [evidence, window] = await Promise.all([
    historyEvidence(
      ctx,
      actor,
      rows
        .filter((row) => row.projection_authorized === 1 && row.pass_id !== null)
        .map((row) => row.id),
    ),
    undoWindowMinutes(ctx),
  ]);
  const provenPolicies = [...evidence.proofs.values()].filter((proof) =>
    evidence.policies.has(proof.scan.id),
  );
  const final = await finalHistoryRead<RecentRow>(ctx, actor, events, csrf, provenPolicies, (at) =>
    recentScansStmt(ctx.env.DB, actor, limit, at, events, csrf),
  );
  const latest = new Map(final.rows.map((row) => [row.id, row]));
  return {
    items: rows.flatMap((row) => {
      const current = latest.get(row.id);
      if (!current || !sameHistorySnapshot(row, current)) return [];
      const proof = evidence.proofs.get(row.id);
      const sources = proof ? historyProofPolicySources(proof) : null;
      const policy = evidence.policies.get(row.id);
      const action = policy?.action(row.action_id, row.action_kind) ?? null;
      const safe =
        row.projection_authorized === 1 &&
        current.projection_authorized === 1 &&
        final.proven.has(row.id) &&
        !!proof &&
        !!sources &&
        !!policy &&
        (row.action_id === null || action !== null || row.action_kind === 'undo');
      if (!safe || !proof || !sources || !policy)
        return [
          {
            scanId: row.id,
            at: row.at,
            outcome: row.outcome,
            reason: null,
            actionLabel: 'Scan',
            title: null,
            value: null,
            undoable: false,
          },
        ];
      const reason = ScanReasonSchema.safeParse(row.reason);
      return [
        {
          scanId: row.id,
          at: row.at,
          outcome: row.outcome,
          reason: reason.success ? reason.data : null,
          actionLabel: row.action_kind === 'undo' ? 'Undo' : (action?.label ?? 'Scan'),
          title: policy.titleVisible(sources.currentTitle) ? sources.currentTitle : null,
          value: null,
          undoable:
            !!action &&
            row.outcome === 'ok' &&
            row.undone_by === null &&
            row.action_kind !== 'undo' &&
            now - row.at <= window * MINUTE,
        },
      ];
    }),
  };
}

/** `GET /summary`: totals stay minimal; an action bucket requires every signed contributor. */
export async function summaryFor(
  ctx: ServiceContext,
  actor: ScanActor,
  since?: number,
): Promise<z.infer<typeof ScanSummarySchema>> {
  ctx = credentialKeysetContext(ctx);
  actor = cloneObservedScanActor(actor);
  const now = ctx.clock.now();
  const from = Math.max(since ?? now - DAY, now - DAY);
  const csrf = await actorCsrfFence(ctx, actor);
  if (!csrf)
    return {
      from,
      to: now,
      total: 0,
      ok: 0,
      headsUp: 0,
      refused: 0,
      undone: 0,
      byAction: [],
      firstAt: null,
      lastAt: null,
    };
  const events = await historyEventSnapshots(ctx.env.DB, actor, from, now);
  const groups = new Map<string | null, { seen: number; blocked: boolean; label: string | null }>();
  const proofPages: HistoryProofFence[][] = [];
  const readCandidates = summaryCandidateReader(ctx.env.DB, actor, from, now, now, events, csrf);
  let after = '';
  for (;;) {
    const page = await readCandidates(after);
    if (page.length === 0) break;
    const last = page.at(-1);
    if (!last) throw new Error('Missing scan summary page boundary.');
    const eligible = page.filter((row) => {
      const group = groups.get(row.action_id) ?? { seen: 0, blocked: false, label: null };
      group.seen += 1;
      if (
        row.action_id === null ||
        row.projection_authorized !== 1 ||
        row.action_kind !== 'check_in' ||
        row.amount !== null ||
        row.before_value !== null ||
        row.after_value !== null
      )
        group.blocked = true;
      groups.set(row.action_id, group);
      return !group.blocked;
    });
    const evidence = await historyEvidence(
      ctx,
      actor,
      eligible.map((row) => row.id),
    );
    const proofs: HistoryProofFence[] = [];
    for (const row of eligible) {
      const group = groups.get(row.action_id);
      if (!group) throw new Error('Missing scan summary action group.');
      if (group.blocked) continue;
      const proof = evidence.proofs.get(row.id);
      const sources = proof ? historyProofPolicySources(proof) : null;
      const action = evidence.policies.get(row.id)?.action(row.action_id, row.action_kind) ?? null;
      if (
        !proof ||
        !sources ||
        sources.scan.actionId !== row.action_id ||
        sources.scan.actionKind !== row.action_kind ||
        sources.scan.outcome !== 'ok' ||
        sources.scan.undoneBy !== null ||
        sources.amount !== null ||
        sources.before !== null ||
        sources.after !== null ||
        !action ||
        (group.label !== null && group.label !== action.label)
      ) {
        group.blocked = true;
        continue;
      }
      group.label = action.label;
      proofs.push({
        scan: { id: proof.scan.id, eventId: proof.scan.eventId },
        projectionCurrent: proof.projectionCurrent,
        credentialKeysetCommitment: proof.credentialKeysetCommitment,
        snapshot: proof.snapshot,
      });
    }
    if (proofs.length) proofPages.push(proofs);
    after = last.id;
    if (page.length < 100) break;
  }

  const finalNow = ctx.clock.now();
  const fences = historyProofFenceStmts(ctx.env.DB, actor, finalNow, events, proofPages, csrf, {
    from,
    to: now,
  });
  const statements = [
    summaryTotalsStmt(ctx.env.DB, actor, from, now, finalNow, events, csrf),
    summaryActionCountsStmt(ctx.env.DB, actor, from, now, finalNow, events, csrf),
    ...fences.map((entry) => entry.statement),
  ];
  const results = await ctx.env.DB.batch(statements);
  const totals = results[0]?.results?.[0] as SummaryTotals | undefined;
  const actionResult = results[1];
  if (!totals || !actionResult) throw new Error('Unable to read scan summary.');
  const counts = (actionResult.results ?? []) as SummaryActionCount[];
  const proven = new Map<string, number>();
  for (const actionId of verifiedHistoryRows(fences, results.slice(2)).values()) {
    if (actionId !== null) proven.set(actionId, (proven.get(actionId) ?? 0) + 1);
  }
  const byAction: { actionId: string; label: string; count: number; amount: number }[] = [];
  let unsafe = groups.size !== counts.length;
  for (const { action_id: id, n, projection_authorized } of counts) {
    const group = groups.get(id);
    if (
      id === null ||
      projection_authorized !== 1 ||
      !group ||
      group.blocked ||
      group.label === null ||
      group.seen !== n ||
      proven.get(id) !== n
    ) {
      unsafe = true;
      break;
    }
    byAction.push({ actionId: id, label: group.label, count: n, amount: 0 });
  }
  return {
    from,
    to: now,
    total: totals.total,
    ok: totals.ok,
    headsUp: totals.heads_up,
    refused: totals.refused,
    undone: totals.undone,
    byAction: unsafe ? [] : byAction,
    firstAt: totals.first_at,
    lastAt: totals.last_at,
  };
}
