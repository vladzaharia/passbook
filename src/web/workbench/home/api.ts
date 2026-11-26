import type { DeveloperHome } from '../../../shared/contracts/developer-home.ts';

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
