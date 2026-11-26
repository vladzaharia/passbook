import { PATHS } from '../../../shared/developers.ts';
import { missTerm } from '../../../shared/developers-search.ts';
import { loadSession } from '../../workbench/console/session.ts';
import type { SearchIndex } from './types.ts';

/**
 * Everything the search sends over the network, in one place. The index is one fixed GET. A lookup
 * takes an id the caller already classified; a miss takes a term that `missTerm` cleared. Nothing
 * here accepts the text of the search box, so a pasted secret has no way out.
 */

const API = '/api/v1/developer';
const json = { accept: 'application/json' };

let indexLoad: Promise<SearchIndex> | null = null;

/** The index, once per page; a failure is forgotten so the next open tries again. */
export function loadIndex(): Promise<SearchIndex> {
  indexLoad ??= fetch(PATHS.searchIndex, { credentials: 'omit', headers: json })
    .then((res) => {
      if (!res.ok) throw new Error(`search index ${res.status}`);
      return res.json() as Promise<SearchIndex>;
    })
    .catch((error: unknown) => {
      indexLoad = null;
      throw error;
    });
  return indexLoad;
}

export interface Resolved {
  kind: 'request' | 'pass' | 'template' | 'org';
  /** Where it opens: the request log row, or the sandbox's admin page for the object. */
  href: string;
  /** For a request: `GET /passes`, 404. */
  label: string;
}

export type Lookup =
  | { state: 'found'; found: Resolved }
  | { state: 'none' }
  | { state: 'signed-out' }
  | { state: 'failed' };

/** A request id or object id in the signed-in person's sandbox. Same origin, with the session. */
export async function resolveId(id: string, signal?: AbortSignal): Promise<Lookup> {
  try {
    const res = await fetch(`${API}/resolve?id=${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
      headers: json,
      signal,
    });
    if (res.status === 401) return { state: 'signed-out' };
    if (res.status === 404) return { state: 'none' };
    if (!res.ok) return { state: 'failed' };
    return { state: 'found', found: (await res.json()) as Resolved };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { state: 'failed' };
  }
}

export interface Activity {
  count: number;
  /** More than the page held. */
  more: boolean;
  lastAt: number | null;
}

const DAY = 86_400_000;

/** How often an error code shows in the sandbox's log in the last day; null signed out or without a sandbox. */
export async function codeActivity(code: string, signal?: AbortSignal): Promise<Activity | null> {
  try {
    // Without a sandbox there is no log: asking would only log a 404.
    if ((await loadSession()).kind !== 'ready') return null;
    const res = await fetch(`${API}/logs?${new URLSearchParams({ code, limit: '100' })}`, {
      credentials: 'same-origin',
      headers: json,
      signal,
    });
    if (!res.ok) return null;
    const page = (await res.json()) as { items: { at: number }[]; nextCursor: string | null };
    const since = Date.now() - DAY;
    const recent = page.items.filter((i) => i.at >= since);
    return {
      count: recent.length,
      more: page.nextCursor !== null && recent.length === page.items.length,
      lastAt: recent[0]?.at ?? null,
    };
  } catch {
    // Preview extra only: offline or blocked leaves it out.
    return null;
  }
}

const reported = new Set<string>();

/**
 * Reports a search that found nothing: the term only, cleared by `missTerm`, once per term per
 * page, with no cookies and no referrer. Returns whether anything was sent.
 */
export function reportMiss(raw: string): boolean {
  const term = missTerm(raw);
  if (!term || reported.has(term)) return false;
  reported.add(term);
  void fetch(PATHS.searchMiss, {
    method: 'POST',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ term }),
  }).catch(() => {
    // Best effort: the backlog misses one term, the reader notices nothing.
  });
  return true;
}
