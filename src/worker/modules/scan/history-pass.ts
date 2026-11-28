import type { z } from 'zod';
import { ScanReasonSchema } from '../../../shared/contracts/scan.ts';
import {
  HISTORY_DAYS,
  type HistoryEvent,
  type HistoryItem,
  type HistoryPage,
  type HistoryQuerySchema,
} from '../../../shared/contracts/scan-history.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { evidenceFor } from './history.ts';
import type { HistoryRow } from './history-row.ts';
import type { HistoryEvidence } from './history-row-evidence.ts';
import { mayReadNotes, readsAllowed } from './history-scope.ts';
import { passFor } from './notes.ts';
import { passHistorySelector } from './repo-history-pass.ts';
import { readHistoryPage } from './repo-history-rows.ts';
import { type NoteRow, readNotes } from './repo-notes.ts';
import { auditPassRead } from './repo-read-audit.ts';
import { scanReadAuthority } from './repo-read-authority.ts';
import { HISTORY_READ } from './repo-scan-history.ts';
import { ROLE_RANK } from './rules.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';
import { staleScanRead } from './stale-read.ts';

const DAY = 86_400_000;
const VALUE_KINDS = new Set(['add', 'take', 'set', 'use_up']);

type Query = z.infer<typeof HistoryQuerySchema>;
type Role = NonNullable<ScanActor['role']>;

function eventOf(row: HistoryRow, vouched: boolean): HistoryEvent {
  if (row.raw.raw_undone_by !== null) return 'undone';
  if (row.outcome === 'refused' || row.outcome === null) return 'refused';
  if (row.outcome === 'heads_up') return 'held';
  // Without the signed policy a scan is a receipt: when and that it passed, not what it did.
  if (!vouched) return 'scanned';
  if (row.override) return 'let_in';
  if (row.actionKind !== null && VALUE_KINDS.has(row.actionKind)) return 'value';
  return row.direction === 'out' ? 'checked_out' : 'checked_in';
}

/** A scan as this role may read it; every field past the event waits on the signed policy and the role. */
function scanLine(row: HistoryRow, found: HistoryEvidence | undefined, role: Role): HistoryItem {
  const policy = found?.policy ?? null;
  const action = policy?.action(row.actionId, row.actionKind) ?? null;
  const vouched = policy !== null && (row.actionId === null || action !== null);
  const desk = ROLE_RANK[role] >= ROLE_RANK.desk;
  const name = row.scannerName ?? '';
  const reason = vouched ? ScanReasonSchema.safeParse(row.reason) : null;
  return {
    id: row.id,
    at: row.at,
    event: eventOf(row, vouched),
    reason: reason?.success ? reason.data : null,
    label: vouched ? (action?.label ?? null) : null,
    place:
      vouched && policy?.scannerNameVisible(name)
        ? name
        : row.actorType === 'user'
          ? 'Console'
          : 'Scanner',
    staff:
      desk && vouched && row.staffName !== null && policy?.valueSafe(row.staffName)
        ? row.staffName
        : null,
    amount: desk && vouched && action !== null ? row.amount : null,
  };
}

const noteLine = (row: NoteRow): HistoryItem => ({
  id: row.id,
  at: row.created_at,
  event: 'note',
  reason: null,
  label: null,
  place: null,
  staff: row.author_name,
  amount: null,
});

const newest = (a: HistoryItem, b: HistoryItem) =>
  b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

function cursorOf(raw: string | undefined): { at: number; id: string } | undefined {
  if (!raw) return undefined;
  const at = raw.indexOf('_');
  return { at: Number(raw.slice(0, at)), id: raw.slice(at + 1) };
}

/**
 * `GET /scan/passes/{id}/history`: 30 days of one person, newest first, from one snapshot per source
 * under the actor's own fence. A Door reads visits only, with no staff or values; notes ride along for
 * Desk and above. A scan the signed policy does not vouch for is a time and a result, nothing more.
 */
export async function passHistory(
  context: ServiceContext,
  source: ScanActor,
  passId: string,
  query: Query,
): Promise<HistoryPage> {
  const actor = cloneObservedScanActor(source);
  const role = actor.role;
  const empty: HistoryPage = { items: [], nextCursor: null };
  const now = context.clock.now();
  if (role === null || !readsAllowed(actor, now)) return empty;
  const door = ROLE_RANK[role] < ROLE_RANK.desk;
  if (door && query.filter === 'changes') return empty;
  const pass = await passFor(context, actor, passId);
  const auth = scanReadAuthority(actor, {
    now,
    read: HISTORY_READ,
    templateId: pass.templateId,
  });
  const take = query.limit + 1;
  const before = cursorOf(query.cursor);
  const since = now - HISTORY_DAYS * DAY;
  const notes = !door && query.filter !== 'visits' && mayReadNotes(actor, now);
  const [scans, noted] = await Promise.all([
    readHistoryPage(
      context.env.DB,
      auth,
      {
        ...passHistorySelector(actor, {
          passId,
          templateId: pass.templateId,
          since,
          filter: door ? 'visits' : query.filter,
          ...(before ? { before } : {}),
          limit: take,
        }),
        // The `+` keeps the planner on this pass's own index, not the org's.
        tenant: auth.tenantOnce('+s', 'scans'),
      },
      now,
    ),
    notes
      ? readNotes(context.env.DB, auth, {
          passId,
          templateId: pass.templateId,
          generation: pass.credentialGeneration,
          since,
          ...(before ? { before } : {}),
          limit: take,
        })
      : { authorized: true, rows: [] as NoteRow[] },
  ]);
  if (!scans.authorized || !noted.authorized) throw await staleScanRead(context, actor);
  const evidence = await evidenceFor(context, actor, scans.rows);
  const lines = [
    ...scans.rows.map((row) => scanLine(row, evidence.get(row.id), role)),
    ...noted.rows.map(noteLine),
  ].sort(newest);
  const items = lines.slice(0, query.limit);
  // One row per history opened (its first page), with the count and no content; the notes read beside it shares the row.
  if (!before) await auditPassRead(context, actor, passId, 'scan.history.read', items.length);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: lines.length > query.limit && last ? `${last.at}_${last.id}` : null,
  };
}
