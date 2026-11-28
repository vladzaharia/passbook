import type { z } from 'zod';
import { ScanReasonSchema } from '../../../shared/contracts/scan.ts';
import type {
  ScanRecentSchema,
  ScanSummarySchema,
} from '../../../shared/contracts/scan-session.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { directedLabel } from './direction-label.ts';
import type { ScanActor } from './guard.ts';
import type { HistoryRow } from './history-row.ts';
import {
  createHistoryEvidenceCache,
  type HistoryEvidence,
  historyEvidenceOf,
  withKeyset,
} from './history-row-evidence.ts';
import { undoWindowMinutes } from './outcome.ts';
import { bucketOutcome } from './outcome-bucket.ts';
import { readHistoryPage } from './repo-history-rows.ts';
import { scanReadAuthority } from './repo-read-authority.ts';
import {
  HISTORY_READ,
  historyProjectable,
  historyReadable,
  ownScansWhere,
  readSummary,
  SUMMARY_CONTRIBUTORS,
} from './repo-scan-history.ts';
import { readSummaryExtras } from './repo-summary-extras.ts';
import { isPasslessReason, type PasslessReason } from './scan-passless.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';
import { staleScanRead } from './stale-read.ts';
import { sessionSummaryFor, summaryExtrasOf } from './summary-session.ts';

const DAY = 86_400_000;
const MINUTE = 60_000;

/** A refusal that selected no pass (the ledger scope admits it only as such) names its own reason. */
function passlessReason(row: HistoryRow): PasslessReason | null {
  return row.passId === null &&
    row.templateId === null &&
    row.actionId === null &&
    row.outcome === 'refused' &&
    isPasslessReason(row.reason)
    ? row.reason
    : null;
}

/** The viewer's evidence for rows read under a projectable fence; none otherwise. */
export async function evidenceFor(
  ctx: ServiceContext,
  actor: ScanActor,
  rows: readonly HistoryRow[],
): Promise<Map<string, HistoryEvidence>> {
  if (!historyProjectable(actor)) return new Map();
  const cache = createHistoryEvidenceCache();
  return withKeyset(ctx, rows, () =>
    historyEvidenceOf(ctx, rows, { role: actor.role, cache, requireAvailable: false }),
  );
}

/**
 * `GET /scans`: the actor's own history from one snapshot. Rows whose pass, proof or policy do not
 * hold in that snapshot are reduced to a receipt.
 */
export async function recentFor(
  ctx: ServiceContext,
  source: ScanActor,
  limit: number,
): Promise<z.infer<typeof ScanRecentSchema>> {
  const actor = cloneObservedScanActor(source);
  if (!historyReadable(actor)) return { items: [] };
  const now = ctx.clock.now();
  const auth = scanReadAuthority(actor, { now, read: HISTORY_READ });
  const own = ownScansWhere(actor);
  const [page, window] = await Promise.all([
    readHistoryPage(
      ctx.env.DB,
      auth,
      // The `+` keeps the planner on the actor's own index, not the org's.
      { where: own.sql, params: own.params, limit, tenant: auth.tenantOnce('+s', 'scans') },
      now,
    ),
    undoWindowMinutes(ctx),
  ]);
  if (!page.authorized) throw await staleScanRead(ctx, actor);
  const evidence = await evidenceFor(ctx, actor, page.rows);
  return {
    items: page.rows.map((row) => {
      const found = evidence.get(row.id);
      const policy = found?.policy ?? null;
      const action = policy?.action(row.actionId, row.actionKind) ?? null;
      if (
        !found ||
        !policy ||
        (row.actionId !== null && action === null && row.actionKind !== 'undo')
      )
        return {
          scanId: row.id,
          at: row.at,
          outcome: row.outcome ?? 'refused',
          reason: passlessReason(row),
          actionLabel: 'Scan',
          title: null,
          value: null,
          undoable: false,
        };
      const reason = ScanReasonSchema.safeParse(row.reason);
      const title = found.sources.currentTitle;
      return {
        scanId: row.id,
        at: row.at,
        outcome: bucketOutcome(row.outcome, row.reason),
        reason: reason.success ? reason.data : null,
        actionLabel:
          row.actionKind === 'undo'
            ? 'Undo'
            : action
              ? directedLabel(action.kind, action.label, row.direction)
              : 'Scan',
        title: policy.titleVisible(title) ? title : null,
        value: null,
        undoable:
          !!action &&
          row.outcome === 'ok' &&
          row.raw.raw_undone_by === null &&
          row.actionKind !== 'undo' &&
          now - row.at <= window * MINUTE,
      };
    }),
  };
}

/**
 * `GET /summary`: totals stay minimal; an action bucket needs every contributor of the window to
 * be a plain check-in whose signed policy names one action label. Past the contributor cap, or when
 * any contributor fails, no bucket is listed and the totals stay exact.
 */
export async function summaryFor(
  ctx: ServiceContext,
  source: ScanActor,
  since?: number,
  scope: 'device' | 'session' = 'device',
): Promise<z.infer<typeof ScanSummarySchema>> {
  if (scope === 'session') return sessionSummaryFor(ctx, source, since);
  const actor = cloneObservedScanActor(source);
  const now = ctx.clock.now();
  const from = Math.max(since ?? now - DAY, now - DAY);
  const empty = {
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
    scope: 'device' as const,
    timeZone: actor.timeZone,
    byHour: [],
    byValue: [],
    byReason: [],
    byType: [],
    byStaff: [],
    overrides: { count: 0, latest: [] },
  };
  if (!historyReadable(actor)) return empty;
  const auth = scanReadAuthority(actor, { now, read: HISTORY_READ });
  const own = ownScansWhere(actor);
  // One trip: the page batch and the extra tallies go out together.
  const [read, extras] = await Promise.all([
    readSummary(ctx.env.DB, auth, actor, { from, to: now }, now),
    readSummaryExtras(ctx.env.DB, auth, { where: own.sql, params: own.params }, { from, to: now }),
  ]);
  if (!read.authorized || !extras.authorized) throw await staleScanRead(ctx, actor);
  const { totals, rows } = read;
  if (!totals) throw new Error('Unable to read scan summary.');
  const projectable = historyProjectable(actor);
  const groups = new Map<string | null, { seen: number; blocked: boolean; label: string | null }>();
  for (const row of rows) {
    const group = groups.get(row.actionId) ?? { seen: 0, blocked: false, label: null };
    group.seen += 1;
    if (
      row.actionId === null ||
      !projectable ||
      row.actionKind !== 'check_in' ||
      row.amount !== null ||
      row.before !== null ||
      row.after !== null
    )
      group.blocked = true;
    groups.set(row.actionId, group);
  }
  const eligible = rows.filter((row) => !groups.get(row.actionId)?.blocked);
  const evidence = eligible.length ? await evidenceFor(ctx, actor, eligible) : new Map();
  for (const row of eligible) {
    const group = groups.get(row.actionId);
    if (!group) continue;
    const action = evidence.get(row.id)?.policy?.action(row.actionId, row.actionKind) ?? null;
    if (!action || (group.label !== null && group.label !== action.label)) group.blocked = true;
    else group.label = action.label;
  }
  const unsafe =
    rows.length > SUMMARY_CONTRIBUTORS ||
    [...groups].some(([id, g]) => id === null || g.blocked || g.label === null);
  const byAction = unsafe
    ? []
    : [...groups]
        .flatMap(([id, g]) =>
          id !== null && g.label !== null
            ? [{ actionId: id, label: g.label, count: g.seen, amount: 0 }]
            : [],
        )
        .sort((a, b) => (a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : 0));
  return {
    from,
    to: now,
    total: totals.total,
    ok: totals.ok,
    headsUp: totals.heads_up,
    refused: totals.refused,
    undone: totals.undone,
    byAction,
    firstAt: totals.first_at,
    lastAt: totals.last_at,
    scope: 'device',
    ...summaryExtrasOf(extras, actor.timeZone),
    byStaff: [],
  };
}
