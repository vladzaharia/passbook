import { alert } from './ledger.ts';
import { allowedRoutes } from './routes.ts';
import { type BindingEnv, IdpError } from './types.ts';

const TIMEOUT_MS = 5_000;
const MAX_BODY = 256 * 1024;

export interface Deps {
  fetch: typeof fetch;
  now: () => number;
  /** Which transport `fetch` uses; absent means public HTTPS. */
  transport?: 'binding' | 'https';
}

export interface PocketResponse {
  status: number;
  body: unknown;
  requestId: string | null;
}

export type Req = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  payload?: unknown,
) => Promise<PocketResponse>;

async function readCapped(res: Response): Promise<string> {
  if (!res.body || res.status === 204) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new IdpError('IDP_UPSTREAM', 'Polaris ID answered with too much data.');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * One Polaris ID request: only an allow-listed method and route (routes.ts), origin pinned, no redirects, 5 s, 256 KB. The key goes in `X-API-KEY` only;
 * no header, body or url is returned for logging, and errors carry the status alone.
 */
export async function pocketRequest(
  env: BindingEnv,
  deps: Deps,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  payload?: unknown,
): Promise<PocketResponse> {
  // The key travels on every request, reads included: the origin must be https, bare and exactly the setting.
  let origin: URL;
  try {
    origin = new URL(env.POCKET_ID_ORIGIN);
  } catch {
    throw new IdpError('IDP_MISCONFIGURED', 'The Polaris ID origin is not valid.');
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.origin !== env.POCKET_ID_ORIGIN
  )
    throw new IdpError('IDP_MISCONFIGURED', 'The Polaris ID origin is not valid.');
  const url = new URL(path, env.POCKET_ID_ORIGIN);
  const layout = env.POCKET_ID_API === 'admin' ? 'admin' : 'v2';
  if (
    !allowedRoutes(layout, env.PASSBOOK_CLIENT_ID).some(
      (r) => r.method === method && r.path.test(url.pathname),
    ) ||
    url.origin !== env.POCKET_ID_ORIGIN ||
    !url.pathname.startsWith('/api/') ||
    !path.startsWith('/api/') ||
    path.includes('..') ||
    path.includes('\\')
  )
    throw new IdpError('IDP_MISCONFIGURED', 'Request left the Polaris ID origin.');
  let res: Response;
  try {
    res = await deps.fetch(url.toString(), {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'x-api-key': env.POCKET_ID_API_KEY,
        accept: 'application/json',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  } catch {
    // Fail closed: a bound transport never falls back to public HTTPS.
    alert('error', 'binding.upstream_unreachable', { transport: deps.transport ?? 'https' });
    throw new IdpError('IDP_UPSTREAM', 'Polaris ID was unreachable.');
  }
  let raw: string;
  try {
    raw = await readCapped(res);
  } catch (error) {
    if (error instanceof IdpError) throw error;
    throw new IdpError('IDP_UPSTREAM', 'Polaris ID answer could not be read.');
  }
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }
  return { status: res.status, body, requestId: res.headers.get('x-request-id') };
}

export const ok = (res: PocketResponse) => res.status >= 200 && res.status < 300;

/** Maps a non-2xx answer to a binding error. Polaris ID's text is not forwarded. */
export function failure(res: PocketResponse): IdpError {
  const tail = `Polaris ID answered ${res.status}.`;
  if (res.status === 401 || res.status === 403) return new IdpError('IDP_AUTH', tail);
  if (res.status === 404) return new IdpError('IDP_NOT_FOUND', tail);
  if ([400, 409, 422].includes(res.status)) return new IdpError('IDP_CONFLICT', tail);
  return new IdpError('IDP_UPSTREAM', tail);
}
