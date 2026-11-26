import type { ScanRecordDto } from '@/shared/contracts/scanners.ts';
import { SCAN_REASON_COPY } from '@/shared/copy/scan.ts';

/** One result vocabulary for Activity, scan detail and session activity (status.ts SCAN_STATUS). */
export function scanStatusKey(outcome: string, undoneAt?: number | null) {
  if (undoneAt || outcome === 'undone') return 'scan_undone';
  if (outcome === 'ok') return 'scan_done';
  if (outcome === 'heads_up') return 'scan_heads_up';
  return 'scan_refused';
}

const METHODS: Record<string, string> = {
  camera: 'Camera',
  wedge: 'Scanner gun',
  nfc: 'NFC',
  manual: 'Typed',
  auto: 'Automatic',
};

export const methodLabel = (method: string) => METHODS[method] ?? method;

/** The action's label, else the reason in plain words; never a raw code. */
export function actionText(
  row: Pick<ScanRecordDto, 'actionLabel' | 'reason'> & Partial<Pick<ScanRecordDto, 'passId'>>,
): string {
  if (row.actionLabel) return row.actionLabel;
  // The Pass cell already says "No pass matched".
  if (!row.reason || (row.reason === 'not_found' && row.passId === null)) return '—';
  return (SCAN_REASON_COPY[row.reason] as { headline: string } | undefined)?.headline ?? '—';
}

type Source = Pick<ScanRecordDto, 'scannerName' | 'scannerId' | 'actor'>;

/** Console scans say so; a scanner row never falls back to the console. */
export function whereText(row: Source): string {
  if (row.scannerName) return row.scannerName;
  return row.scannerId || row.actor.type === 'scanner' ? 'Scanner' : 'Admin scan';
}

/** A dash when no staff member is on the row: a column of "Not signed in" is noise. */
export function whoText(row: Source & Pick<ScanRecordDto, 'staffName' | 'staffId'>): string {
  if (row.actor.type === 'user') return 'Admin';
  if (row.staffName) return row.staffName;
  if (row.staffId) return 'Staff';
  return '—';
}
