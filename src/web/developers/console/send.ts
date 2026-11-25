import { exhausted, spend } from './budget.ts';
import { masked, maskedJson } from './mask.ts';
import { type Draft, wireOf } from './request.ts';
import { drop, TokenError, token } from './token.ts';
import type { Json, RunOp } from './types.ts';

const SHOWN = [
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'retry-after',
  'idempotent-replayed',
  'etag',
  'content-type',
  'passbook-warning',
] as const;
const MAX_TEXT = 256 * 1024;

export interface Outcome {
  status: number;
  statusText: string;
  ms: number;
  requestId: string | null;
  replayed: boolean;
  headers: [string, string][];
  /** The body as text, tokens cut, capped. Always drawn as text. */
  text: string;
  truncated: boolean;
  json: Json | undefined;
  /** The Idempotency-Key this call carried, for "same key again". */
  key: string | null;
}

async function staleToken(res: Response): Promise<boolean> {
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { code?: unknown };
  return body.code === 'UNAUTHENTICATED';
}

export class RunError extends Error {
  readonly code: 'network' | 'token';
  constructor(code: 'network' | 'token', message: string) {
    super(message);
    this.code = code;
  }
}

async function call(
  path: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
  csrf: string,
): Promise<Response> {
  const bearer = await token(csrf);
  spend();
  return fetch(path, {
    ...init,
    redirect: 'error',
    headers: { ...init.headers, authorization: `Bearer ${bearer}` },
  });
}

async function once(op: RunOp, draft: Draft, csrf: string): Promise<Response> {
  const wire = wireOf(op, draft);
  return call(
    wire.path,
    {
      method: op.method.toUpperCase(),
      headers: wire.headers,
      ...(wire.body !== undefined ? { body: wire.body } : {}),
    },
    csrf,
  );
}

/** A read the page makes for itself (the template's sample): the try token goes in here, nowhere else. A stale token is refused as UNAUTHENTICATED: forget it and ask once more. */
export async function readWithToken(
  path: string,
  headers: Record<string, string>,
  csrf: string,
): Promise<Response> {
  let res = await call(path, { headers }, csrf);
  if (res.status === 401) {
    drop();
    res = await call(path, { headers }, csrf);
  }
  return res;
}

/** Sends the request with the try token. One retry with a fresh token when the first is refused as stale. */
export async function send(op: RunOp, draft: Draft, csrf: string): Promise<Outcome> {
  const started = performance.now();
  let res: Response;
  try {
    res = await once(op, draft, csrf);
    // Only the guard's own refusal means a stale token; a 401 from a handler may have done work.
    if (res.status === 401 && (await staleToken(res))) {
      drop();
      res = await once(op, draft, csrf);
    }
  } catch (e) {
    if (e instanceof TokenError) throw new RunError('token', e.message);
    throw new RunError('network', 'Could not reach the API. Check your connection and run again.');
  }
  const raw = await res.text();
  const ms = Math.round(performance.now() - started);
  if (res.status === 429) exhausted(Number(res.headers.get('retry-after')) || 60);
  const text = masked(raw.length > MAX_TEXT ? raw.slice(0, MAX_TEXT) : raw);
  let json: Json | undefined;
  try {
    json = raw.length <= MAX_TEXT && raw !== '' ? maskedJson(JSON.parse(raw) as Json) : undefined;
  } catch {
    // Not JSON (a proxy page, an empty body): drawn as text.
  }
  return {
    status: res.status,
    statusText: res.statusText,
    ms,
    requestId: res.headers.get('x-request-id'),
    replayed: res.headers.get('idempotent-replayed') === 'true',
    headers: SHOWN.flatMap((n) => {
      const v = res.headers.get(n);
      return v === null ? [] : [[n, masked(v)] as [string, string]];
    }),
    text,
    truncated: raw.length > MAX_TEXT,
    json,
    key: op.idempotent && draft.idemOn ? draft.idemKey : null,
  };
}
