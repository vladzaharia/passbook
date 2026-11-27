import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../../platform/context.ts';
import { redactString } from '../../platform/log.ts';
import { type ServiceContext, serviceContext } from '../../platform/service-context.ts';
import {
  FLAG_IDEMPOTENCY_KEY,
  FLAG_IF_MATCH,
  FLAG_VERSION,
  insertLog,
  type NewLog,
} from './repo-request-log.ts';
import { bodiesRecorded } from './request-log-bodies.ts';
import { clientOf } from './request-log-client.ts';
import { headersJson } from './request-log-headers.ts';
import { BODY_READ_MAX_BYTES, redactBody, redactQuery } from './request-log-redact.ts';

/** Only a Test secret or a try token can be a sandbox's, so only they are ever copied: a Live call is never read. */
const TEST_BEARER = /^Bearer\s+(?:pbp?_test_|pbtry_)/i;
/** Reading the log is not logged. */
const NOT_LOGGED = /^\/api\/v1\/(?:developer\/(?:logs|rail)|request-logs)(?:\/|$)/;
/** The pass, template or key a path names. */
const RESOURCE =
  /\/(?:passes|templates|api-keys)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;
/** A decoded path may carry control characters, which a terminal would act on: each becomes `?`. */
const printable = (text: string): string =>
  Array.from(text, (ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return c < 32 || (c >= 127 && c < 160) ? '?' : ch;
  }).join('');
const VERSION = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z0-9_]{2,64}$/;

/** What the portal's own background reads call themselves, so the workbench can leave them out of its Calls. */
export const PORTAL_CLIENT = 'portal';
const portalCall = (via: string | null | undefined, header: string | undefined) =>
  via === 'try' && header === PORTAL_CLIENT;

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
function stored(read: Read | null, type: string | null): { text: string; truncated: boolean } {
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

/** What the request body will be: nothing, a copy of its stream, or a one-line marker (not JSON, or too large). */
type Sent = { copy: ReadableStream<Uint8Array> } | { marker: string; truncated: boolean } | null;

function sentOf(c: { req: { raw: Request; header(name: string): string | undefined } }): Sent {
  const raw = c.req.raw;
  if (!raw.body) return null;
  const type = c.req.header('content-type') ?? null;
  if (!isJson(type)) return { marker: redactBody('', type, 0).text, truncated: false };
  // No length (chunked): copied and read up to the cap, which `readCapped` enforces.
  const length = Number(c.req.header('content-length') ?? 0);
  if (length > BODY_READ_MAX_BYTES)
    return { marker: redactBody('', type, BODY_READ_MAX_BYTES + 1).text, truncated: true };
  const copy = raw.clone().body;
  return copy ? { copy } : null;
}

/** Which of the three headers a call carried: presence only; allowlisted values go in `headers`. */
const flagsOf = (header: (name: string) => string | undefined) =>
  (header('idempotency-key') !== undefined ? FLAG_IDEMPOTENCY_KEY : 0) |
  (header('if-match') !== undefined ? FLAG_IF_MATCH : 0) |
  (header('passbook-version') !== undefined ? FLAG_VERSION : 0);

/**
 * Logs an org's Test calls to `request_log` after the response is made: one background write (`waitUntil`), so
 * the request pays for nothing but copying a small JSON stream. Nothing else is logged: not a Live call, and the
 * insert and the table's triggers back that up. Headers are kept from a fixed allowlist of non-secret ones
 * (`request-log-headers.ts`), so no secret can be stored; the pinned version date and the presence flags stay too. Bodies are kept only where the
 * org records them (`bodiesRecorded`). The request is copied only when its bearer looks like a Test secret or
 * try token and its body is JSON of at most 16 KB.
 */
export const requestLog = createMiddleware<AppBindings>(async (c, next) => {
  const sent = TEST_BEARER.test(c.req.header('authorization') ?? '') ? sentOf(c) : null;
  const started = c.var.clock.now();
  await next();
  const auth = c.var.auth;
  if (
    auth?.kind !== 'api_key' ||
    auth.orgId === null ||
    auth.mode !== 'test' ||
    NOT_LOGGED.test(c.req.path)
  ) {
    if (sent && 'copy' in sent) void sent.copy.cancel();
    return;
  }
  const res = c.res;
  const ctx = serviceContext(c);
  const row: Omit<NewLog, 'requestBody' | 'responseBody' | 'code'> = {
    id: c.var.ids.id(),
    orgId: auth.orgId,
    keyId: auth.keyId,
    via: auth.via ?? null,
    client: portalCall(auth.via, c.req.header('x-passbook-client'))
      ? PORTAL_CLIENT
      : clientOf(c.req.header('user-agent')),
    mode: auth.mode,
    requestId: c.var.requestId,
    method: c.req.method,
    route: c.req.routePath === '/*' ? null : c.req.routePath,
    // Hono decodes the path, so an escape sequence in it is stripped before it is stored and printed.
    path: printable(redactString(c.req.path)).slice(0, 300),
    query: redactQuery(new URL(c.req.url).search),
    status: res.status,
    durationMs: c.var.clock.now() - started,
    at: started,
    resourceId: RESOURCE.exec(c.req.path)?.[1] ?? null,
    apiVersion: VERSION.test(c.req.header('passbook-version') ?? '')
      ? (c.req.header('passbook-version') ?? null)
      : null,
    flags: flagsOf((name) => c.req.header(name)),
    headers: headersJson((name) => c.req.header(name), res.headers),
  };
  const type = res.headers.get('content-type');
  const copies = { sent, received: res.clone().body, type };
  ctx.waitUntil(
    bodiesRecorded(ctx, auth.orgId, auth.orgKind).then((record) =>
      writeLog(ctx, row, copies, record),
    ),
  );
});

interface Copies {
  sent: Sent;
  received: ReadableStream<Uint8Array> | null;
  type: string | null;
}

/** Reads the copies, then makes the one insert. A failure is logged by `waitUntil`, never thrown into the request. */
export async function writeLog(
  ctx: ServiceContext,
  row: Omit<NewLog, 'requestBody' | 'responseBody' | 'code'>,
  { sent, received, type }: Copies,
  /** False: the org keeps no bodies; they are read for the code and the resource, then dropped. */
  record = true,
): Promise<void> {
  const receivedJson = isJson(type);
  const [sentRead, receivedRead] = await Promise.all([
    sent && 'copy' in sent && record ? readCapped(sent.copy, BODY_READ_MAX_BYTES) : null,
    receivedJson ? readCapped(received, BODY_READ_MAX_BYTES) : null,
  ]);
  // Not JSON: nothing of it is read, only its type is noted.
  if (received && !receivedJson) await received.cancel();
  if (sent && 'copy' in sent && !record) await sent.copy.cancel();
  const requestStored =
    !record || !sent
      ? null
      : 'marker' in sent
        ? { text: sent.marker, truncated: sent.truncated }
        : stored(sentRead, 'application/json');
  const responseStored = record && received ? stored(receivedRead, type) : null;
  await insertLog(ctx.env.DB, {
    ...row,
    requestBody: requestStored?.text ?? null,
    responseBody: responseStored?.text ?? null,
    bodiesTruncated: Boolean(requestStored?.truncated || responseStored?.truncated),
    code: receivedJson && row.status >= 400 ? codeOf(receivedRead) : null,
  });
}
