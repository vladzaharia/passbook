import { formatDateTime } from '../overview/format.ts';

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

type Value = string | number | boolean | null;

export interface DataItem {
  label: string;
  value: string;
}

export function dataItems(
  data: Record<string, Value>,
  orgName: (id: string | null) => string,
): DataItem[] {
  const items: DataItem[] = [];
  for (const [key, raw] of Object.entries(data)) {
    if (raw === null) continue;
    if (key === 'orgId') {
      items.push({ label: 'Organization', value: orgName(String(raw)) });
      continue;
    }
    let value: string;
    if (typeof raw === 'boolean') value = raw ? 'Yes' : 'No';
    else if (key === 'lastRunAt' && typeof raw === 'number') value = formatDateTime(raw);
    else if (key === 'oldestAgeSeconds' && typeof raw === 'number') value = `${raw} s`;
    else value = String(raw);
    items.push({ label: LABELS[key] ?? key, value });
  }
  return items;
}
