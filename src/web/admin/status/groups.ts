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

/** "All connections" sums the connection rows; counting it too would report one failure twice. */
export const isAggregate = (c: Pick<Component, 'id'>) => c.id === 'connections';
export const leaves = <T extends Pick<Component, 'id'>>(components: readonly T[]) =>
  components.filter((c) => !isAggregate(c));

/** Leaves that need attention, worst first. */
export function problems<T extends Pick<Component, 'id' | 'state'>>(components: readonly T[]) {
  return leaves(components)
    .filter((c) => c.state === 'failing' || c.state === 'degraded')
    .sort((a, b) => (a.state === b.state ? 0 : a.state === 'failing' ? -1 : 1));
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

const NOUN: Record<Component['kind'], [string, string]> = {
  database: ['database', 'databases'],
  storage: ['storage bucket', 'storage buckets'],
  queue: ['queue', 'queues'],
  cron: ['scheduled job', 'scheduled jobs'],
  build: ['build', 'builds'],
  email: ['email sender', 'email senders'],
  identity: ['Apple identity', 'Apple identities'],
  oidc: ['sign-in provider', 'sign-in providers'],
  connection: ['connection', 'connections'],
  workflow: ['workflow', 'workflows'],
};

/** "1 connection failing", "2 components degraded", or "All good" when nothing needs attention. */
export function headline(components: readonly Pick<Component, 'id' | 'kind' | 'state'>[]): string {
  const bad = problems(components);
  const worst = bad[0]?.state;
  if (!worst) return 'All good';
  const same = bad.filter((c) => c.state === worst);
  const kinds = new Set(same.map((c) => c.kind));
  const n = same.length;
  const [one, many] =
    kinds.size === 1 ? NOUN[same[0]?.kind ?? 'build'] : ['component', 'components'];
  return `${n} ${n === 1 ? one : many} ${worst === 'failing' ? 'failing' : 'degraded'}`;
}

/** The page that owns a component, when there is one. */
export function componentLink(c: Pick<Component, 'id' | 'kind'>): string | undefined {
  const [, id] = /^[a-z]+:(.+)$/.exec(c.id) ?? [];
  if (c.kind === 'connection') return id ? `/admin/connections/${id}` : '/admin/connections';
  if (c.kind === 'identity')
    return id && id !== 'platform' ? `/admin/identities/${id}` : '/admin/identities';
  if (c.kind === 'oidc') return '/admin/settings';
  return undefined;
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

/** The pill a component shows: a deployed cron with no run in a day reads "No recent run". */
export function pillStatus(c: Component): string {
  return c.data?.noRecentRun === true ? 'no_recent_run' : c.state;
}
