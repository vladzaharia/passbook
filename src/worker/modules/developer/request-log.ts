import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../../platform/context.ts';
import { redactString } from '../../platform/log.ts';
import { type ServiceContext, serviceContext } from '../../platform/service-context.ts';
import { insertLog, type NewLog } from './repo-request-log.ts';
import { BODY_READ_MAX_BYTES, queryKeys, redactBody, redactQuery } from './request-log-redact.ts';

/** Only a Test secret or a try token can have a body kept, so only they are ever copied: a Live call is never read. */
const TEST_BEARER = /^Bearer\s+(?:pbp?_test_|pbtry_)/i;
/** Reading the log is not logged. */
const NOT_LOGGED = /^\/api\/v1\/developer\/(?:logs|rail)(?:\/|$)/;
const CODE = /^[A-Z0-9_]{2,64}$/;
const PROBLEM_MAX_BYTES = 4096;

interface Read {
  text: string;
  bytes: number;
}

/** At most `max` bytes of a body; null when it is longer (nothing of it is kept). */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Read | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(all), bytes };
}

const isJson = (type: string | null) => /json/i.test(type ?? '');

/** The stored form of one body, from a copy of its stream taken before the handler or the runtime consumed it. */
function stored(read: Read | null, type: string | null): string {
  return read
    ? redactBody(read.text, type, read.bytes)
    : redactBody('', type, BODY_READ_MAX_BYTES + 1);
}

/** The `code` of a problem+json answer. */
function codeOf(read: Read | null): string | null {
  if (!read) return null;
  try {
    const code = (JSON.parse(read.text) as { code?: unknown }).code;
    return typeof code === 'string' && CODE.test(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * Logs every API-key call to `request_log` after the response is made: one background write (`waitUntil`), so the
 * request pays for nothing but copying a stream. Metadata for every call. Bodies only for a Test secret or try
 * token, and the write itself keeps them only for a developer org (`insertLog`). The code of an error is read from
 * the problem body, which is never stored for a Live call.
 */
export const requestLog = createMiddleware<AppBindings>(async (c, next) => {
  const test = TEST_BEARER.test(c.req.header('authorization') ?? '');
  const requestType = c.req.header('content-type') ?? null;
  const sent = test && c.req.raw.body ? c.req.raw.clone().body : null;
  const started = c.var.clock.now();
  await next();
  const auth = c.var.auth;
  if (auth?.kind !== 'api_key' || auth.orgId === null || NOT_LOGGED.test(c.req.path)) return;
  const res = c.res;
  const type = res.headers.get('content-type');
  const received = test || (res.status >= 400 && isJson(type)) ? res.clone().body : null;
  const search = new URL(c.req.url).search;
  const ctx = serviceContext(c);
  const row: Omit<NewLog, 'requestBody' | 'responseBody' | 'code'> = {
    id: c.var.ids.id(),
    orgId: auth.orgId,
    keyId: auth.keyId,
    via: auth.via ?? null,
    mode: auth.mode,
    requestId: c.var.requestId,
    method: c.req.method,
    route: c.req.routePath === '/*' ? null : c.req.routePath,
    path: redactString(c.req.path).slice(0, 300),
    query: redactQuery(search),
    queryKeys: queryKeys(search),
    status: res.status,
    durationMs: c.var.clock.now() - started,
    at: started,
  };
  ctx.waitUntil(writeLog(ctx, row, { sent, requestType, received, type, test }));
});

interface Copies {
  sent: ReadableStream<Uint8Array> | null;
  requestType: string | null;
  received: ReadableStream<Uint8Array> | null;
  type: string | null;
  test: boolean;
}

/** Reads the copies, then makes the one insert. A failure is logged by `waitUntil`, never thrown into the request. */
export async function writeLog(
  ctx: ServiceContext,
  row: Omit<NewLog, 'requestBody' | 'responseBody' | 'code'>,
  copies: Copies,
): Promise<void> {
  const { test, type, requestType, sent, received } = copies;
  const sentJson = isJson(requestType);
  const receivedJson = isJson(type);
  // A Live call is read for its error code only, and only as far as a problem body goes.
  const [sentRead, receivedRead] = await Promise.all([
    test && sentJson ? readCapped(sent, BODY_READ_MAX_BYTES) : null,
    receivedJson ? readCapped(received, test ? BODY_READ_MAX_BYTES : PROBLEM_MAX_BYTES) : null,
  ]);
  // Not JSON: nothing of it is read, only its type is noted.
  if (sent && !(test && sentJson)) await sent.cancel();
  if (received && !receivedJson) await received.cancel();
  await insertLog(ctx.env.DB, {
    ...row,
    requestBody: test && sent ? stored(sentRead, requestType) : null,
    responseBody: test && received ? stored(receivedRead, type) : null,
    code: receivedJson && row.status >= 400 ? codeOf(receivedRead) : null,
  });
}
