import type { DeveloperHome } from '../../../shared/contracts/developer-home.ts';

const API = '/api/v1/developer';
const HEADERS = { accept: 'application/json' };

/** A refused or failed read: `out` when the session cannot open the workbench (401, 403). */
export class HomeError extends Error {
  readonly out: boolean;
  readonly status: number;
  /** A 429's Retry-After, in seconds. */
  readonly retryAfter: number | undefined;
  constructor(status: number, retryAfter?: number) {
    super(`The workbench could not load (${status}).`);
    this.status = status;
    this.retryAfter = retryAfter;
    this.out = status === 401 || status === 403;
  }
}

export async function fetchHome(fetchFn: typeof fetch = fetch): Promise<DeveloperHome> {
  const res = await fetchFn(`${API}/home`, { headers: HEADERS });
  if (!res.ok) {
    const wait = Number(res.headers.get('retry-after'));
    throw new HomeError(res.status, wait > 0 ? wait : undefined);
  }
  return (await res.json()) as DeveloperHome;
}
