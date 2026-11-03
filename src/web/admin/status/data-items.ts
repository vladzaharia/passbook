import { humanizeStatus, statusOf } from '@/web/lib/status.ts';
import { formatDateTime } from '../../lib/format.ts';

const LABELS: Record<string, string> = {
  backlog: 'Backlog',
  oldestAgeSeconds: 'Oldest message',
  dlq: 'Dead-lettered',
  total: 'Total',
  errored: 'Errored',
  running: 'Running',
  complete: 'Complete',
  source: 'Source',
  daysRemaining: 'Days remaining',
  apnsBinding: 'APNs binding',
  bindingPresent: 'Binding present',
  apnsHealth: 'APNs health',
  sender: 'Sender',
  healthy: 'Healthy',
  degraded: 'Degraded',
  failing: 'Failing',
  unknown: 'Unknown',
  health: 'Health',
  lastRunAt: 'Last run',
  id: 'Build',
};

const SOURCES: Record<string, string> = { env: 'Environment', db: 'Uploaded' };
/** Flags the row already shows (the "No recent run" pill). */
const SKIP = new Set(['noRecentRun']);

type Value = string | number | boolean | null;

export interface DataItem {
  label: string;
  value: string;
}

export function dataItems(
  data: Record<string, Value>,
  orgName: (id: string | null) => string | undefined,
): DataItem[] {
  const items: DataItem[] = [];
  for (const [key, raw] of Object.entries(data)) {
    if (raw === null || SKIP.has(key)) continue;
    if (key === 'orgId') {
      items.push({ label: 'Organization', value: orgName(String(raw)) ?? '—' });
      continue;
    }
    let value: string;
    if (typeof raw === 'boolean') value = raw ? 'Yes' : 'No';
    else if (key === 'lastRunAt' && typeof raw === 'number') value = formatDateTime(raw);
    else if (key === 'oldestAgeSeconds' && typeof raw === 'number') value = `${raw} s`;
    else if (key === 'source' && typeof raw === 'string')
      value = SOURCES[raw] ?? humanizeStatus(raw);
    else if ((key === 'health' || key === 'apnsHealth') && typeof raw === 'string')
      value = statusOf(raw)?.label ?? humanizeStatus(raw);
    else value = String(raw);
    items.push({ label: LABELS[key] ?? key, value });
  }
  return items;
}
