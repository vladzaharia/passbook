import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanRole } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { HistoryPolicy } from './history-policy.ts';
import { type HistoryRaw, type HistoryRow, toHistoryRow } from './history-row.ts';
import {
  createHistoryEvidenceCache,
  type HistoryEvidenceCache,
  historyEvidenceOf,
} from './history-row-evidence.ts';
import { manifestCacheKey } from './repo-template-manifests.ts';
import type { Found } from './resolve.ts';
import type { DisplayRow } from './scan-display-history-view.ts';

/** What a display read is for: one pass's check-ins, optionally of one event. */
export interface DisplayReadScope {
  orgId: string;
  mode: Mode;
  passId: string;
  templateId: string;
  eventId: string | null;
  credentialKeysetCommitment: string;
}

export interface DecodedPage {
  ids: string[];
  /** The rows a display may show; a scan of `ids` that is missing here is not exposable. */
  rows: Map<string, DisplayRow>;
}

export type DisplayHistoryRaw = HistoryRaw & { candidate_total?: number };

/**
 * The evidence cache of one display read, with the manifests this request already resolved: a
 * template version is its content hash, so most scans were recorded under one of them and need no
 * read of their own.
 */
export function displayEvidenceCache(orgId: string, found: Found): HistoryEvidenceCache {
  const cache = createHistoryEvidenceCache();
  for (const template of [found.template, found.activePolicy, found.activeTemplate])
    if (template?.id === found.pass.templateId)
      cache.manifests.set(
        manifestCacheKey({ orgId, templateId: template.id, version: template.version }),
        JSON.stringify(template.manifest),
      );
  return cache;
}

/** A plain, successful, signed-in check-in: the only scan a display lists. */
export function isDisplayCheckIn(
  scan: {
    passId: string | null;
    templateId: string | null;
    actionKind: string | null;
    outcome: string | null;
    undoneBy: string | null;
    amount: number | null;
    before: string | null;
    after: string | null;
  },
  scope: { passId: string; templateId: string },
): boolean {
  return (
    scan.passId === scope.passId &&
    scan.templateId === scope.templateId &&
    scan.actionKind === 'check_in' &&
    scan.outcome === 'ok' &&
    scan.undoneBy === null &&
    scan.amount === null &&
    scan.before === null &&
    scan.after === null
  );
}

/** The listed row: the action's label and where the scan happened, as the viewer's policy allows. */
export function displayRowOf(
  policy: HistoryPolicy | null,
  scan: { id: string; at: number; actionId: string | null; actionKind: string | null },
  scanner: { id: string | null; name: string | null },
): DisplayRow | null {
  const action = policy?.action(scan.actionId, scan.actionKind) ?? null;
  if (!policy || !action) return null;
  return {
    id: scan.id,
    at: scan.at,
    label: action.label,
    where:
      policy.scannerNameVisible(scanner.name) && scanner.name !== null
        ? scanner.name
        : scanner.id
          ? 'Scanner'
          : 'Console',
  };
}

const listed = (row: HistoryRow, scope: DisplayReadScope) =>
  isDisplayCheckIn({ ...row, undoneBy: row.raw.raw_undone_by }, scope);

/**
 * Decode one page of a pass-scoped read. Null when the page is not what was asked for (a foreign
 * tenant, pass, template or event, or a repeated scan): such a page proves nothing. A scan whose
 * signed event, pass state or policy does not hold gets no row, so the display is not complete.
 */
export async function decodeDisplayPage(
  ctx: ServiceContext,
  raws: readonly DisplayHistoryRaw[],
  scope: DisplayReadScope,
  role: ScanRole | null,
  cache: HistoryEvidenceCache,
): Promise<DecodedPage | null> {
  const ids: string[] = [];
  const unique = new Set<string>();
  for (const raw of raws) {
    if (
      typeof raw.id !== 'string' ||
      unique.has(raw.id) ||
      raw.org_id !== scope.orgId ||
      raw.mode !== scope.mode ||
      raw.pass_id !== scope.passId ||
      raw.template_id !== scope.templateId ||
      (scope.eventId !== null && raw.raw_event_id !== scope.eventId)
    )
      return null;
    unique.add(raw.id);
    ids.push(raw.id);
  }
  const history = raws.map(toHistoryRow);
  const evidence = await historyEvidenceOf(ctx, history, {
    role,
    cache,
    requireAvailable: false,
    wanted: (row) => listed(row, scope),
    commitment: scope.credentialKeysetCommitment,
  });
  const rows = new Map<string, DisplayRow>();
  for (const row of history) {
    const found = evidence.get(row.id);
    if (!found) continue;
    const shown = displayRowOf(
      found.policy,
      { id: row.id, at: row.at, actionId: row.actionId, actionKind: row.actionKind },
      { id: row.raw.raw_scanner_id, name: found.sources.currentScannerName },
    );
    if (shown) rows.set(row.id, shown);
  }
  return { ids, rows };
}
