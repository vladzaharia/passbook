import type { z } from 'zod';
import type { ComponentStatusSchema } from '@/shared/contracts/status.ts';
import { formatDateTime } from '../overview/format.ts';

export type Component = z.infer<typeof ComponentStatusSchema>;
export type State = Component['state'];

export interface GroupDef {
  id: string;
  title: string;
  kinds: readonly Component['kind'][];
}

export const GROUPS: readonly GroupDef[] = [
  { id: 'platform', title: 'Platform', kinds: ['database', 'storage', 'queue', 'cron', 'build'] },
  { id: 'delivery', title: 'Delivery', kinds: ['email', 'identity'] },
  { id: 'sign-in', title: 'Sign-in', kinds: ['oidc'] },
  { id: 'integrations', title: 'Integrations', kinds: ['connection', 'workflow'] },
];

export function groupComponents<T extends Pick<Component, 'kind'>>(components: readonly T[]) {
  return GROUPS.map((g) => ({
    ...g,
    items: components.filter((c) => g.kinds.includes(c.kind)),
  })).filter((g) => g.items.length > 0);
}

export function countStates(components: readonly Pick<Component, 'state'>[]) {
  const counts: Record<State, number> = {
    failing: 0,
    degraded: 0,
    not_configured: 0,
    configured: 0,
    verified: 0,
  };
  for (const c of components) counts[c.state]++;
  return counts;
}

export function headline(counts: Record<State, number>): string {
  if (counts.failing > 0)
    return `${counts.failing} ${counts.failing === 1 ? 'component' : 'components'} failing`;
  if (counts.degraded > 0)
    return `${counts.degraded} ${counts.degraded === 1 ? 'component' : 'components'} degraded`;
  const rest = counts.not_configured + counts.configured;
  return rest === 0 ? 'All systems verified' : 'No problems found';
}

const num = (v: unknown) => (typeof v === 'number' ? v : null);
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** One line under the label: the server detail, else a summary of the data. */
export function summaryLine(c: Component): string | null {
  if (c.detail) return c.detail;
  const d = c.data ?? {};
  switch (c.kind) {
    case 'queue':
      return `${num(d.backlog) ?? 0} queued, ${num(d.dlq) ?? 0} dead-lettered`;
    case 'connection':
      return num(d.total) === null ? null : plural(num(d.total) ?? 0, 'connection');
    case 'workflow':
      return `${plural(num(d.total) ?? 0, 'run')} in 24 h`;
    case 'identity':
      return num(d.daysRemaining) === null
        ? null
        : `Certificate valid for ${plural(num(d.daysRemaining) ?? 0, 'day')}`;
    case 'email':
      return typeof d.sender === 'string' ? `Sends as ${d.sender}` : null;
    case 'cron':
      return num(d.lastRunAt) === null ? null : `Last run ${formatDateTime(num(d.lastRunAt))}`;
    case 'build':
      return typeof d.id === 'string' ? `Build ${d.id.slice(0, 8)}` : null;
    default:
      return null;
  }
}
