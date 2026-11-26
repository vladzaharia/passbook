import { mintJwt } from './jwt.ts';
import { AscError, type ProvisionerEnv } from './types.ts';

export const ASC_BASE = 'https://api.appstoreconnect.apple.com';

export interface Deps {
  fetch: typeof fetch;
  now: () => number;
}

export interface AscResponse {
  status: number;
  body: { data?: unknown; included?: unknown; errors?: { id?: string; code?: string }[] } | null;
  requestId: string | null;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One Apple request. Never returns an auth header or body to callers' logs; the caller records status and request id only. */
export async function ascRequest(
  env: ProvisionerEnv,
  deps: Deps,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  payload?: unknown,
): Promise<AscResponse> {
  const token = await mintJwt(env, deps.now());
  let res: Response;
  try {
    res = await deps.fetch(`${ASC_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  } catch {
    throw new AscError('ASC_UPSTREAM', 'Apple was unreachable.');
  }
  const raw = res.status === 204 ? '' : await res.text();
  let body: AscResponse['body'] = null;
  if (raw) {
    try {
      body = JSON.parse(raw) as AscResponse['body'];
    } catch {
      body = null;
    }
  }
  const requestId =
    res.headers.get('x-request-id') ??
    res.headers.get('x-apple-request-uuid') ??
    body?.errors?.[0]?.id ??
    null;
  return { status: res.status, body, requestId };
}

/** Maps a non-2xx Apple answer to a provisioner error. Apple's detail text is not forwarded. */
export function failure(res: AscResponse): AscError {
  const apple = text(res.body?.errors?.[0]?.code);
  const tail = `Apple answered ${res.status}${apple ? ` (${apple})` : ''}.`;
  if (res.status === 401 || res.status === 403) return new AscError('ASC_AUTH', tail);
  if (res.status === 404) return new AscError('ASC_NOT_FOUND', tail);
  if (res.status === 409) return new AscError('ASC_CONFLICT', tail);
  return new AscError('ASC_UPSTREAM', tail);
}
