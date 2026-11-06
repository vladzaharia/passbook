import type { z } from 'zod';
import type {
  ScanRecentSchema,
  ScanSummarySchema,
} from '../../../shared/contracts/scan-session.ts';
import { scanOf } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isNotFound, resolveTemplate } from '../passes/builder.ts';
import type { ScanActor } from './guard.ts';
import { undoWindowMinutes } from './outcome.ts';
import { recentScans, summaryRows } from './repo-scans.ts';

const DAY = 86_400_000;
const MINUTE = 60_000;

/** Action labels per template, from the templates the rows name. A template gone leaves the id. */
async function labelsOf(ctx: ServiceContext, actor: ScanActor, templateIds: (string | null)[]) {
  const labels = new Map<string, string>();
  for (const id of new Set(templateIds.filter((t): t is string => t !== null))) {
    try {
      const t = await resolveTemplate(ctx, actor.orgId, id);
      for (const a of scanOf(t.manifest).actions) labels.set(`${id}:${a.id}`, a.label);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return labels;
}

/** `GET /scans`: this actor's latest scans. */
export async function recentFor(
  ctx: ServiceContext,
  actor: ScanActor,
  limit: number,
): Promise<z.infer<typeof ScanRecentSchema>> {
  const rows = await recentScans(ctx.env.DB, actor.actorKey, limit);
  const [labels, window] = await Promise.all([
    labelsOf(
      ctx,
      actor,
      rows.map((r) => r.template_id),
    ),
    undoWindowMinutes(ctx),
  ]);
  const now = ctx.clock.now();
  return {
    items: rows.map((r) => ({
      scanId: r.id,
      at: r.at,
      outcome: r.outcome,
      reason: r.reason as z.infer<typeof ScanRecentSchema>['items'][number]['reason'],
      actionLabel:
        r.action_kind === 'undo'
          ? 'Undo'
          : (labels.get(`${r.template_id}:${r.action_id}`) ?? r.action_id ?? 'Scan'),
      title: r.title,
      value: null,
      undoable:
        r.outcome === 'ok' &&
        r.undone_by === null &&
        r.action_kind !== 'undo' &&
        now - r.at <= window * MINUTE,
    })),
  };
}

/** `GET /summary`: this actor's tally since a time at most a day back. */
export async function summaryFor(
  ctx: ServiceContext,
  actor: ScanActor,
  since?: number,
): Promise<z.infer<typeof ScanSummarySchema>> {
  const now = ctx.clock.now();
  const from = Math.max(since ?? now - DAY, now - DAY);
  const rows = await summaryRows(ctx.env.DB, actor.actorKey, from, now);
  const labels = await labelsOf(
    ctx,
    actor,
    rows.map((r) => r.template_id),
  );
  const by = new Map<string, { actionId: string; label: string; count: number; amount: number }>();
  let ok = 0;
  let headsUp = 0;
  let refused = 0;
  let undone = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  for (const r of rows) {
    if (r.outcome === 'ok') ok += r.n;
    else if (r.outcome === 'heads_up') headsUp += r.n;
    else refused += r.n;
    if (r.undone === 1) undone += r.n;
    firstAt = firstAt === null ? r.first_at : Math.min(firstAt, r.first_at);
    lastAt = lastAt === null ? r.last_at : Math.max(lastAt, r.last_at);
    if (r.outcome === 'ok' && r.undone === 0 && r.action_id) {
      const row = by.get(r.action_id) ?? {
        actionId: r.action_id,
        label: labels.get(`${r.template_id}:${r.action_id}`) ?? r.action_id,
        count: 0,
        amount: 0,
      };
      row.count += r.n;
      row.amount += r.amount;
      by.set(r.action_id, row);
    }
  }
  return {
    from,
    to: now,
    total: ok + headsUp + refused,
    ok,
    headsUp,
    refused,
    undone,
    byAction: [...by.values()],
    firstAt,
    lastAt,
  };
}
