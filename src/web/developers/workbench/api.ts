import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import type { DeveloperHome } from '../../../shared/contracts/developer-home.ts';
import type { Source } from './model.ts';

const API = '/api/v1/developer';
const HEADERS = { accept: 'application/json' };

/** A refused or failed read: `out` when the session cannot open the workbench (401, 403). */
export class HomeError extends Error {
  readonly out: boolean;
  constructor(status: number) {
    super(`The workbench could not load (${status}).`);
    this.out = status === 401 || status === 403;
  }
}

export async function fetchHome(fetchFn: typeof fetch = fetch): Promise<DeveloperHome> {
  const res = await fetchFn(`${API}/home`, { headers: HEADERS });
  if (!res.ok) throw new HomeError(res.status);
  return (await res.json()) as DeveloperHome;
}

/** The latest calls from one source; `all` is what the home already carries. */
export async function fetchCalls(
  source: Source,
  fetchFn: typeof fetch = fetch,
): Promise<RequestLogEntry[]> {
  const res = await fetchFn(`${API}/logs?limit=8&portal=hide&source=${source}`, {
    headers: HEADERS,
  });
  if (!res.ok) throw new HomeError(res.status);
  return ((await res.json()) as { items: RequestLogEntry[] }).items;
}
