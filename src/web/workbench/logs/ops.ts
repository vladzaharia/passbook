import { PATHS } from '../../../shared/developers.ts';
import { wbPath } from '../../../shared/workbench.ts';

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

/** The operation a logged call ran, by its route (`/api/v1/passes/:id`) as the document spells it. */
export function opOf(index: OpIndex, method: string, route: string | null): string | null {
  if (!route) return null;
  const doc = route.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return index[`${method} ${doc}`] ?? null;
}

/**
 * Open in Console: the operation, and the request it came from. The body never rides in the address;
 * the Console reads the redacted one by `from` (design §4.3).
 */
export const consoleLink = (orgId: string, op: string, requestId: string): string =>
  wbPath(orgId, 'console', { query: { op, from: requestId } });
