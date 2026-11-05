import type { z } from 'zod';
import type { TemplateManifest } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  ScanFeedRowSchema,
  ScanOutcome,
  ScanRecordDto,
} from '../../../shared/contracts/index.ts';
import { scanOf } from '../../../shared/scan-defaults.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { bump } from '../../platform/counters.ts';
import { batch } from '../../platform/db.ts';
import {
  NotFoundError,
  RateLimitedError,
  UnavailableError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { csvRow, EXPORT_COLUMNS, exportCells } from './feed-csv.ts';
import {
  countScanRows,
  getScanRow,
  listScanRows,
  manifestsOf,
  type ScanLogFilter,
  type ScanLogRow,
} from './repo-feed.ts';

type Feed = z.infer<typeof ScanFeedRowSchema>;

const DAY = 86_400_000;
export const UNDO_MAX_MS = 30 * DAY;
export const EXPORT_MAX_RANGE_MS = 92 * DAY;
export const EXPORT_MAX_ROWS = 100_000;
export const EXPORTS_PER_HOUR = 10;
const EXPORT_PAGE = 1000;

export interface ConsoleUndoInput {
  scanId: string;
  orgId: string;
  mode: Mode;
  idempotencyKey: string;
  maxAgeMs: number;
}

/** SV.6's undo service, run as an admin. */
export type ConsoleUndo = (
  ctx: ServiceContext,
  session: SessionAuth,
  input: ConsoleUndoInput,
) => Promise<ScanOutcome>;

/** Stands in until SV.6a merges; the integration step swaps in the real service. */
export const consoleUndo: ConsoleUndo = async () => {
  throw new UnavailableError('Undo is not available yet.', 'SCAN_UNDO_UNAVAILABLE');
};

const KIND_LABEL: Record<string, string> = {
  check_in: 'Check in',
  add: 'Add',
  take: 'Take',
  set: 'Set',
  use_up: 'Use up',
  undo: 'Undo',
};

const parse = (json: string | null): ScanRecordDto['before'] => (json ? JSON.parse(json) : null);

/** The label the template gives the action now; the kind's name when the action or template is gone. */
async function labelsOf(ctx: ServiceContext, rows: readonly ScanLogRow[]) {
  const manifests = await manifestsOf(ctx.env.DB, [
    ...new Set(rows.flatMap((r) => (r.templateId ? [r.templateId] : []))),
  ]);
  const parsed = new Map<string, Map<string, string>>();
  return (row: ScanLogRow): string | null => {
    if (row.actionKind === 'undo') return KIND_LABEL.undo ?? null;
    if (row.templateId && row.actionId) {
      let labels = parsed.get(row.templateId);
      if (!labels) {
        const raw = manifests.get(row.templateId);
        labels = new Map(
          raw
            ? scanOf(JSON.parse(raw) as TemplateManifest).actions.map((a) => [a.id, a.label])
            : [],
        );
        parsed.set(row.templateId, labels);
      }
      const label = labels.get(row.actionId);
      if (label) return label;
    }
    return row.actionKind ? (KIND_LABEL[row.actionKind] ?? null) : null;
  };
}

function toRecord(row: ScanLogRow, label: string | null): ScanRecordDto {
  return {
    id: row.id,
    at: row.at,
    outcome: row.outcome ?? 'refused',
    reason: row.reason as ScanRecordDto['reason'],
    kind: row.actionKind as ScanRecordDto['kind'],
    actionId: row.actionId,
    actionLabel: label,
    direction: row.direction,
    passId: row.passId,
    passTitle: row.passTitle,
    templateId: row.templateId,
    templateName: row.templateName,
    eventId: row.eventId,
    eventName: row.eventName,
    scannerId: row.scannerId,
    scannerName: row.scannerName,
    staffId: row.staffId,
    staffName: row.staffName,
    approvedBy: row.approvedBy,
    method: row.method === 'auto' ? 'manual' : row.method,
    amount: row.amount,
    before: parse(row.before),
    after: parse(row.after),
    passVersion: row.passVersion,
    override: row.override,
    offline: row.offline,
    actor: { type: row.actorType === 'user' ? 'user' : 'scanner', id: row.actorId },
    undoneAt: row.undoneAt,
    undoneBy: row.undoneBy,
    undoes: row.undoes,
  };
}

/** For API keys: no pass titles, no staff names, no holder data. */
function toFeed(row: ScanLogRow): Feed {
  return {
    id: row.id,
    at: row.at,
    passId: row.passId,
    externalId: row.externalId,
    templateId: row.templateId,
    eventId: row.eventId,
    actionId: row.actionId,
    kind: row.actionKind as Feed['kind'],
    outcome: row.outcome ?? 'refused',
    reason: row.reason as Feed['reason'],
    amount: row.amount,
    before: parse(row.before),
    after: parse(row.after),
    method: row.method === 'auto' ? 'manual' : row.method,
    scannerId: row.scannerId,
    scannerName: row.scannerName,
    undoneAt: row.undoneAt,
  };
}

async function page(ctx: ServiceContext, filter: ScanLogFilter) {
  const rows = await listScanRows(ctx.env.DB, { ...filter, limit: filter.limit + 1 });
  const shown = rows.slice(0, filter.limit);
  return { shown, nextCursor: rows.length > filter.limit ? (shown.at(-1)?.id ?? null) : null };
}

export async function listScanRecords(ctx: ServiceContext, filter: ScanLogFilter) {
  const { shown, nextCursor } = await page(ctx, filter);
  const label = await labelsOf(ctx, shown);
  return { items: shown.map((r) => toRecord(r, label(r))), nextCursor };
}

export async function listScanFeed(ctx: ServiceContext, filter: ScanLogFilter) {
  const { shown, nextCursor } = await page(ctx, filter);
  return { items: shown.map(toFeed), nextCursor };
}

/** The raw row, for the undo and detail routes. */
export async function loadScanRow(ctx: ServiceContext, id: string): Promise<ScanLogRow> {
  const row = await getScanRow(ctx.env.DB, id);
  if (!row) throw new NotFoundError('Scan not found.', 'SCAN_NOT_FOUND');
  return row;
}

export async function scanRecord(ctx: ServiceContext, id: string): Promise<ScanRecordDto> {
  const row = await loadScanRow(ctx, id);
  return toRecord(row, (await labelsOf(ctx, [row]))(row));
}

export interface ExportRequest {
  mode: Mode;
  orgId: string;
  from: number;
  to: number;
  filter: Omit<ScanLogFilter, 'mode' | 'orgId' | 'from' | 'to' | 'cursor' | 'limit'>;
}

/**
 * Checks the limits, counts the export against the user's hourly cap, audits it, and returns the CSV
 * as a stream of pages. Nothing is held in memory beyond one page.
 */
export async function exportScans(
  ctx: ServiceContext,
  userId: string,
  req: ExportRequest,
): Promise<{ name: string; body: ReadableStream<Uint8Array> }> {
  if (req.to <= req.from || req.to - req.from > EXPORT_MAX_RANGE_MS)
    throw new ValidationError('Export up to 92 days at a time.', [], 'SCAN_EXPORT_RANGE');
  const filter: ScanLogFilter = {
    ...req.filter,
    mode: req.mode,
    orgId: req.orgId,
    from: req.from,
    to: req.to,
    limit: EXPORT_PAGE,
  };
  const now = ctx.clock.now();
  const hour = now - (now % 3_600_000);
  if ((await bump(ctx.env.DB, `scan:export:${userId}`, hour)) > EXPORTS_PER_HOUR)
    throw new RateLimitedError(Math.ceil((hour + 3_600_000 - now) / 1000));
  const rows = await countScanRows(ctx.env.DB, filter, EXPORT_MAX_ROWS);
  if (rows > EXPORT_MAX_ROWS)
    throw new ValidationError('Export up to 100,000 scans at a time.', [], 'SCAN_EXPORT_TOO_LARGE');
  await batch(ctx.env.DB, [
    auditStmt(ctx.env.DB, ctx, {
      orgId: req.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scan.export',
      targetType: 'org',
      targetId: req.orgId,
      detail: { from: req.from, to: req.to, rows },
    }),
  ]);
  const encoder = new TextEncoder();
  let cursor: string | undefined;
  let started = false;
  let done = false;
  const stamp = (at: number) => new Date(at).toISOString().slice(0, 10);
  return {
    name: `scans-${stamp(req.from)}-${stamp(req.to)}.csv`,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!started) {
          started = true;
          controller.enqueue(encoder.encode(`﻿${csvRow(EXPORT_COLUMNS)}`));
          return;
        }
        const chunk = await listScanRows(ctx.env.DB, { ...filter, ...(cursor ? { cursor } : {}) });
        if (chunk.length === 0) return controller.close();
        const label = await labelsOf(ctx, chunk);
        cursor = chunk.at(-1)?.id;
        done = chunk.length < EXPORT_PAGE;
        controller.enqueue(
          encoder.encode(chunk.map((r) => csvRow(exportCells(r, label(r)))).join('')),
        );
        if (done) controller.close();
      },
    }),
  };
}
