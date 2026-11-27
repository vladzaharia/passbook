import { ApiError } from '../../lib/errors.ts';
import { exhausted } from './budget.ts';
import type { Transport } from './client.ts';
import { masked, maskedJson } from './mask.ts';
import { type Draft, wireOf } from './request.ts';
import { TokenError } from './token.ts';
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

export class RunError extends Error {
  readonly code: 'network' | 'token';
  constructor(code: 'network' | 'token', message: string) {
    super(message);
    this.code = code;
  }
}

/** Sends the request on `transport`: the bearer is the transport's, never this module's. */
export async function send(op: RunOp, draft: Draft, transport: Transport): Promise<Outcome> {
  const started = performance.now();
  let res: Response;
  try {
    const wire = wireOf(op, draft);
    res = await transport(wire.path, {
      method: op.method.toUpperCase(),
      headers: wire.headers,
      ...(wire.body !== undefined ? { body: wire.body } : {}),
    });
  } catch (e) {
    if (e instanceof TokenError) throw new RunError('token', e.message);
    if (e instanceof ApiError && e.status !== 0) throw new RunError('token', masked(e.message));
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
