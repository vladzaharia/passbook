import { vi } from 'vitest';
import type { ApiRail, RequestLogEntry } from '../../../shared/contracts/developer.ts';
import { forgetRail } from '../bench/rail.ts';
import { mountLogs } from './island.ts';

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const entry = (n: number, over: Partial<RequestLogEntry> = {}): RequestLogEntry => ({
  id: `log-${n}`,
  requestId: `req-${n}`,
  at: Date.now() - n * 1000,
  method: 'POST',
  route: '/api/v1/passes/:id',
  path: '/api/v1/passes/p1',
  query: 'a=1',
  status: 201,
  code: null,
  durationMs: 12,
  keyId: 'key-12345678-xyz',
  mode: 'test',
  via: null,
  client: 'curl/8.7.1',
  hasBodies: true,
  ...over,
});

export const page = (items: unknown[], extra: Record<string, unknown> = {}) =>
  json({ items, nextCursor: null, capped: null, ...extra });

export const rail: ApiRail = {
  mode: 'test',
  scopes: ['passes:read', 'passes:write'],
  tier: 'standard',
  limitPerMinute: 1200,
  callsLastHour: 3456,
  series: [0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1],
  key: { id: 'key-12345678-xyz', name: 'Sandbox key', prefix: 'pb_test_ab12' },
};

interface Api {
  calls: string[];
  /** List answers, consumed in order; then an empty page. */
  lists: Response[];
}

/**
 * A fetch that answers by path: the rail, a row's detail, the portal probe (`source=try&limit=1`) and the list,
 * whose answers are consumed in order.
 */
function api(
  lists: Response[],
  o: { detail?: Response; rail?: Response; portal?: Response } = {},
): Api {
  const calls: string[] = [];
  forgetRail();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/developer/rail')) return o.rail?.clone() ?? json(rail);
      if (/logs\/log-/.test(url)) return o.detail?.clone() ?? json({}, 500);
      if (url.includes('source=try&limit=1')) return o.portal?.clone() ?? page([]);
      return lists.shift() ?? page([]);
    }),
  );
  return { calls, lists };
}

const opIndex = Promise.resolve({ 'POST /api/v1/passes/{id}': 'passes.postPassesById' });

/** Mounts the log over `lists`, in a page with a slot for the listener's mark. */
export async function open(lists: Response[], o: Parameters<typeof api>[1] = {}) {
  const { calls } = api(lists, o);
  const live = document.createElement('div');
  const el = document.createElement('div');
  el.textContent = 'prerendered';
  document.body.append(live, el);
  await mountLogs(el, opIndex, live);
  return { el, live, calls };
}

export const rowsOf = (el: HTMLElement) => el.querySelectorAll<HTMLDetailsElement>('.logs-row');

/** Opens a row the way a click does: `open`, then the toggle event (jsdom does not fire it). */
export function expand(row: HTMLDetailsElement | null | undefined): void {
  if (!row) return;
  row.open = true;
  row.dispatchEvent(new Event('toggle'));
}

export function choose(el: HTMLElement, name: string, value: string): void {
  const select = el.querySelector<HTMLSelectElement>(`select[name="${name}"]`);
  if (!select) throw new Error(`no ${name} select`);
  select.value = value;
  select.dispatchEvent(new Event('change'));
}
