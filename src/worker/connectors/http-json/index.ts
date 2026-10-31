import { z } from 'zod';
import type { Json } from '../../../shared/contracts/common.ts';
import { strictEmail } from '../../../shared/email.ts';
import {
  parseJsonBody,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifySignedRequest,
} from '../lib/hmac.ts';
import { assertSafeRef, isAllowedHeaderName, parseJson, request } from '../lib/http.ts';
import { getPointer, isPointer } from '../lib/pointer.ts';
import {
  type ConnectorContext,
  type ConnectorDefinition,
  ConnectorError,
  type UpstreamRecord,
} from '../types.ts';

const MAX_WEBHOOK_REFS = 100;

const pointer = z.string().max(200).refine(isPointer, 'Not a JSON pointer.');
const path = z
  .string()
  .max(300)
  .refine((v) => v.startsWith('/') && !/[?#]/.test(v) && !v.includes('..'), 'Invalid path.');

const config = z.object({
  baseUrl: z
    .url()
    .max(500)
    .refine((v) => {
      if (!URL.canParse(v)) return true;
      const u = new URL(v);
      return !u.search && !u.hash && !u.username && !u.password;
    }, 'No query, fragment or credentials.'),
  recordPath: path
    .refine((v) => v.split('{ref}').length === 2, 'Must contain {ref} once.')
    .default('/{ref}'),
  recordPointer: pointer.default(''),
  holderEmailPointer: pointer.optional(),
  auth: z
    .object({
      type: z.enum(['none', 'bearer', 'basic', 'header']).default('none'),
      headerName: z.string().refine(isAllowedHeaderName, 'Header not allowed.').optional(),
    })
    .default({ type: 'none' }),
  list: z
    .object({
      path,
      cursorParam: z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,40}$/)
        .default('cursor'),
      cursorPointer: pointer.default('/cursor'),
      itemsPointer: pointer.default('/items'),
      refPointer: pointer.default('/id'),
      recordPointer: pointer.default(''),
      deletedPointer: pointer.optional(),
      hasMorePointer: pointer.optional(),
    })
    .optional(),
  webhook: z
    .object({
      eventIdPointer: pointer.default('/id'),
      refsPointer: pointer.default('/refs'),
      signatureHeader: z.string().refine(isAllowedHeaderName).default(SIGNATURE_HEADER),
      timestampHeader: z.string().refine(isAllowedHeaderName).default(TIMESTAMP_HEADER),
    })
    .default({
      eventIdPointer: '/id',
      refsPointer: '/refs',
      signatureHeader: SIGNATURE_HEADER,
      timestampHeader: TIMESTAMP_HEADER,
    }),
  testRef: z.string().max(200).optional(),
});
const secrets = z.object({
  token: z.string().max(4096).optional(),
  username: z.string().max(256).optional(),
  password: z.string().max(1024).optional(),
  headerValue: z.string().max(4096).optional(),
});

type Config = z.infer<typeof config>;
type Secrets = z.infer<typeof secrets>;
type Ctx = ConnectorContext<Config, Secrets>;

function endpoint(base: string, template: string, ref?: string): URL {
  const url = new URL(base);
  const encoded = ref === undefined ? template : template.replace('{ref}', assertSafeRef(ref));
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${encoded}`;
  return url;
}

function authHeaders({ connection, secrets: s }: Ctx): Record<string, string> {
  const { auth } = connection.config;
  if (auth.type === 'none') return {};
  if (auth.type === 'bearer' && s.token) return { authorization: `Bearer ${s.token}` };
  if (auth.type === 'basic' && s.username !== undefined && s.password !== undefined) {
    return { authorization: `Basic ${btoa(`${s.username}:${s.password}`)}` };
  }
  if (auth.type === 'header' && auth.headerName && s.headerValue) {
    return { [auth.headerName]: s.headerValue };
  }
  throw new ConnectorError('CONFIG', { permanent: true });
}

function asRecord(value: Json | undefined): UpstreamRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value === undefined) {
    throw new ConnectorError('INVALID_PAYLOAD');
  }
  return value;
}

async function getJson(ctx: Ctx, url: URL, notFoundOk = false): Promise<unknown | null> {
  const res = await request(
    ctx as ConnectorContext<unknown, unknown>,
    url.toString(),
    authHeaders(ctx),
    {
      notFoundOk,
    },
  );
  return res ? parseJson(res) : null;
}

/** Per-record GET with optional list/delta endpoint and optional HMAC webhook. */
const definition: ConnectorDefinition<Config, Secrets> = {
  type: 'http-json',
  version: 1,
  displayName: 'HTTP JSON',
  capabilities: { poll: true, delta: true, webhook: true },
  configSchema: config,
  secretSchema: secrets,
  outputFields: {},
  urls: (c) => [c.baseUrl],
  hasList: (c) => c.list !== undefined,
  defaults: { intervalSeconds: 900, maxConcurrency: 4, requestsPerMinute: 60, timeoutMs: 15_000 },

  async test(ctx) {
    const { config: c } = ctx.connection;
    if (c.list) {
      const body = await getJson(ctx, endpoint(c.baseUrl, c.list.path));
      if (!Array.isArray(getPointer(body, c.list.itemsPointer))) {
        throw new ConnectorError('INVALID_PAYLOAD');
      }
      return { ok: true, detail: 'List endpoint reachable.' };
    }
    if (c.testRef) {
      const body = await getJson(ctx, endpoint(c.baseUrl, c.recordPath, c.testRef), true);
      return {
        ok: true,
        detail: body === null ? 'Reachable; test record not found.' : 'Record fetched.',
      };
    }
    authHeaders(ctx);
    return { ok: true, detail: 'Config valid; no test target set.' };
  },

  async fetchRecord(ctx, ref) {
    const { config: c } = ctx.connection;
    const body = await getJson(ctx, endpoint(c.baseUrl, c.recordPath, ref), true);
    if (body === null) return { status: 'not_found' };
    const record = asRecord(getPointer(body, c.recordPointer));
    const rawEmail = c.holderEmailPointer ? getPointer(body, c.holderEmailPointer) : undefined;
    const holderEmail = strictEmail(rawEmail);
    return { status: 'ok', record, ...(holderEmail ? { holderEmail } : {}) };
  },

  async listChanges(ctx, cursor) {
    const list = ctx.connection.config.list;
    if (!list) throw new ConnectorError('CONFIG', { permanent: true });
    const url = endpoint(ctx.connection.config.baseUrl, list.path);
    if (cursor) url.searchParams.set(list.cursorParam, cursor);
    const body = await getJson(ctx, url);
    const items = getPointer(body, list.itemsPointer);
    if (!Array.isArray(items)) throw new ConnectorError('INVALID_PAYLOAD');
    const changes = items.map((item) => {
      const rawRef = getPointer(item, list.refPointer);
      if (typeof rawRef !== 'string' && typeof rawRef !== 'number') {
        throw new ConnectorError('INVALID_PAYLOAD');
      }
      const ref = String(rawRef);
      const deleted = list.deletedPointer ? getPointer(item, list.deletedPointer) === true : false;
      const embedded = getPointer(item, list.recordPointer);
      const isObject =
        embedded !== null && typeof embedded === 'object' && !Array.isArray(embedded);
      return {
        ref,
        ...(deleted ? { deleted: true } : {}),
        ...(!deleted && isObject ? { record: embedded as UpstreamRecord } : {}),
      };
    });
    const next = getPointer(body, list.cursorPointer);
    const nextCursor = typeof next === 'string' && next !== '' ? next : null;
    const more = list.hasMorePointer
      ? getPointer(body, list.hasMorePointer) === true
      : nextCursor !== null && nextCursor !== cursor;
    return { changes, cursor: nextCursor ?? cursor ?? '', hasMore: more && nextCursor !== null };
  },

  async verifyWebhook(ctx, req) {
    const { webhook } = ctx.connection.config;
    const { body, signature } = await verifySignedRequest(req, {
      secret: ctx.webhookSecret,
      now: ctx.now(),
      signatureHeader: webhook.signatureHeader,
      timestampHeader: webhook.timestampHeader,
    });
    const payload = parseJsonBody(body);
    const rawRefs = getPointer(payload, webhook.refsPointer);
    if (!Array.isArray(rawRefs) || rawRefs.length > MAX_WEBHOOK_REFS) {
      throw new ConnectorError('INVALID_PAYLOAD');
    }
    const refs = [...new Set(rawRefs.map((r) => (typeof r === 'number' ? String(r) : r)))];
    if (!refs.every((r): r is string => typeof r === 'string' && r.length > 0 && r.length <= 200)) {
      throw new ConnectorError('INVALID_PAYLOAD');
    }
    const rawId = getPointer(payload, webhook.eventIdPointer);
    const eventId =
      typeof rawId === 'string' || typeof rawId === 'number'
        ? String(rawId).slice(0, 200)
        : `sig:${signature.slice(0, 32)}`;
    return { eventId, refs };
  },
};
export default definition;
