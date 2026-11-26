import { safeNextPath } from './next.ts';

/** The Workbench's eleven areas, in nav order (design §1.4). */
export const WB_TOOLS = [
  'home',
  'quickstart',
  'design',
  'passes',
  'console',
  'logs',
  'events',
  'inbox',
  'activity',
  'keys',
  'sandbox',
] as const;
export type WbTool = (typeof WB_TOOLS)[number];

/** Areas only a developer sandbox has; an org's Test shows the other nine. */
export const SANDBOX_ONLY: ReadonlySet<WbTool> = new Set(['quickstart', 'sandbox']);

export const WB_HOME = '/workbench';

/** A path in the Workbench's space: its own shell, guard and announcer. */
export const isWorkbenchPath = (pathname: string): boolean =>
  pathname === WB_HOME || pathname.startsWith(`${WB_HOME}/`);

/** The org a Workbench path names (`/workbench/o/$orgId/…`), else null. */
export function wbOrgOf(pathname: string): string | null {
  const parts = pathname.split('/');
  if (parts[1] !== 'workbench' || parts[2] !== 'o' || !parts[3]) return null;
  try {
    return decodeURIComponent(parts[3]);
  } catch {
    // A malformed escape names no org.
    return null;
  }
}

export const isWbTool = (value: unknown): value is WbTool =>
  typeof value === 'string' && (WB_TOOLS as readonly string[]).includes(value);

/** Areas with a page outside any context: Quickstart, public at step 1. */
const CONTEXT_FREE: ReadonlySet<WbTool> = new Set(['quickstart']);

export interface WbPathOptions {
  /** Filters and launch params. Never a request body (design §4.3, L19). */
  query?: Readonly<Record<string, string | number | undefined>>;
  /** The selection: a record id. */
  hash?: string;
}

/**
 * A Workbench URL: `/workbench/o/$orgId/<tool>?<filters>#<id>`. A body never rides in a URL, so a
 * `body` param throws; prefills travel by `sessionStorage` nonce.
 */
export function wbPath(orgId: string, tool: WbTool, options: WbPathOptions = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (key.toLowerCase() === 'body') throw new Error('A Workbench URL never carries a body.');
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const base = CONTEXT_FREE.has(tool)
    ? `${WB_HOME}/${tool}`
    : `${WB_HOME}/o/${encodeURIComponent(orgId)}${tool === 'home' ? '' : `/${tool}`}`;
  const query = params.toString();
  const hash = options.hash ? `#${encodeURIComponent(options.hash)}` : '';
  return `${base}${query ? `?${query}` : ''}${hash}`;
}

/**
 * What Events opens (design §1.10). The address is `events?<params>#<id>`:
 * - `#<eventId>` selects an event; `?endpoint=<id>` opens that endpoint's delivery of it and
 *   `?capture=<id>` opens that captured request, both inside the selected event;
 * - `?tab=endpoints#<endpointId>` selects an endpoint (the finish of Add endpoint lands here);
 * - `?tab=endpoints&new=1` opens the Add endpoint wizard (it pushes history, so Back closes it);
 * - `?type=`, `?request=` and `?pass=` narrow the list (the request is an `x-request-id`).
 */
export interface WbEventsLink {
  event?: string;
  endpoint?: string;
  capture?: string;
  tab?: 'endpoints';
  add?: boolean;
  type?: string;
  request?: string;
  pass?: string;
}

/** An Events URL: an endpoint is the selection on its own tab, and a filter on an event. */
export function wbEventsPath(orgId: string, link: WbEventsLink = {}): string {
  const endpoints = link.tab === 'endpoints';
  return wbPath(orgId, 'events', {
    query: {
      tab: link.tab,
      new: link.add ? 1 : undefined,
      type: link.type,
      request: link.request,
      pass: link.pass,
      endpoint: endpoints ? undefined : link.endpoint,
      capture: endpoints ? undefined : link.capture,
    },
    hash: endpoints ? link.endpoint : link.event,
  });
}

/** The area a Workbench path shows, or null outside the Workbench. */
export function wbToolOf(pathname: string): WbTool | null {
  const parts = pathname.split(/[?#]/, 1)[0]?.split('/').filter(Boolean) ?? [];
  if (parts[0] !== 'workbench') return null;
  if (parts[1] === 'o') return parts[2] ? (isWbTool(parts[3]) ? parts[3] : 'home') : null;
  return isWbTool(parts[1]) ? parts[1] : null;
}

/** The spaces a launch link may come from (`from=`), and where `return=` may point. */
export const WB_ORIGINS = ['admin', 'developers'] as const;
export type WbOrigin = (typeof WB_ORIGINS)[number];
const RETURN_PREFIXES = ['/admin/', '/developers/', '/workbench/'];

/** A launch link's `return`: a same-origin path under admin, the docs or the Workbench, else null. */
export function safeReturn(raw: string | null | undefined): string | null {
  const path = safeNextPath(raw);
  if (!path) return null;
  const bare = path.split(/[?#]/, 1)[0] ?? '';
  return RETURN_PREFIXES.some((p) => `${bare}/`.startsWith(p)) ? path : null;
}
