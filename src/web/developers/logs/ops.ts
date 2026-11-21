import { PATHS } from '../../../shared/developers.ts';
import { getJson } from './dom.ts';

/** `{ "GET /api/v1/passes/{id}": "passes.getPassesById" }`: built with the portal from the OpenAPI document. */
export type OpIndex = Record<string, string>;

export async function loadOps(): Promise<OpIndex> {
  const { body } = await getJson<OpIndex>(PATHS.logsOps).catch(() => ({ body: null }));
  return body ?? {};
}

/** The console link of a logged call: its route (`/api/v1/passes/:id`) as the document spells it. */
export function builderLink(index: OpIndex, method: string, route: string | null): string | null {
  if (!route) return null;
  const doc = route.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  const id = index[`${method} ${doc}`];
  return id ? `${PATHS.console}#${encodeURIComponent(id)}` : null;
}
