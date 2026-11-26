import { PATHS } from '../../../shared/developers.ts';

/** `{ "GET /api/v1/passes/{id}": "passes.getPassesById" }`: built with the portal from the OpenAPI document. */
export type OpIndex = Record<string, string>;

let pending: Promise<OpIndex> | undefined;

/** One read of the operation index per page: only an opened row needs it, for Run again. */
export function loadOps(): Promise<OpIndex> {
  pending ??= fetch(PATHS.logsOps, { headers: { accept: 'application/json' } })
    .then(async (res) => (res.ok ? ((await res.json()) as OpIndex) : {}))
    // Offline: Run again is left out, the rest of the inspector reads on.
    .catch(() => ({}));
  return pending;
}

/** The console link of a logged call: its route (`/api/v1/passes/:id`) as the document spells it. */
export function builderLink(index: OpIndex, method: string, route: string | null): string | null {
  if (!route) return null;
  const doc = route.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  const id = index[`${method} ${doc}`];
  return id ? `${PATHS.console}#${encodeURIComponent(id)}` : null;
}

/** The longest body Run again carries in the link; a bigger one opens the operation empty. */
const BODY_LINK_MAX = 4000;

/** Run again: the operation in the console, with the logged body when it is JSON and short. */
export function runAgainLink(link: string, requestBody: string | null): string {
  if (!requestBody) return link;
  try {
    const compact = JSON.stringify(JSON.parse(requestBody));
    return compact.length <= BODY_LINK_MAX ? `${link}?body=${encodeURIComponent(compact)}` : link;
  } catch {
    // A marker (`[binary body]`, too large) is not a body to run again.
    return link;
  }
}
