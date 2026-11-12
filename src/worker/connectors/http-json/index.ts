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
    }, 'No query, fragment or credentials.')
    .meta({
      'x-label': 'Base URL',
      'x-help': 'HTTPS. No query string.',
      'x-placeholder': 'https://api.example.com/v1',
      'x-order': 1,
    }),
  recordPath: path
    .refine((v) => v.split('{ref}').length === 2, 'Must contain {ref} once.')
    .default('/{ref}')
    .meta({
      'x-label': 'Record path',
      'x-widget': 'text',
      'x-help': 'Added to the base URL. {ref} is the record ID.',
      'x-placeholder': '/members/{ref}',
      'x-order': 2,
    }),
  recordPointer: pointer.default('').meta({
    'x-label': 'Record location',
    'x-help': 'JSON pointer to the record in the response. Empty means the whole body.',
    'x-placeholder': '/data',
    'x-order': 3,
  }),
  holderEmailPointer: pointer.optional().meta({
    'x-label': 'Holder email',
    'x-help': 'JSON pointer to the email in the response.',
    'x-placeholder': '/email',
    'x-order': 4,
  }),
  testRef: z.string().max(200).optional().meta({
    'x-label': 'Test record ID',
    'x-help': 'Fetched by Test.',
    'x-placeholder': 'm-001',
    'x-order': 5,
  }),
  auth: z
    .object({
      type: z
        .enum(['none', 'bearer', 'basic', 'header'])
        .default('none')
        .meta({
          'x-label': 'Authentication',
          'x-enumLabels': {
            none: 'None',
            bearer: 'Bearer token',
            basic: 'Basic',
            header: 'Header',
          },
        }),
      headerName: z
        .string()
        .refine(isAllowedHeaderName, 'Header not allowed.')
        .optional()
        .meta({ 'x-label': 'Header name', 'x-placeholder': 'X-Api-Key', 'x-auth': ['header'] }),
    })
    .default({ type: 'none' })
    .meta({ 'x-label': 'Authentication' }),
  list: z
    .object({
      path: path.meta({
        'x-label': 'List path',
        'x-widget': 'text',
        'x-help': 'Returns changed records page by page.',
        'x-placeholder': '/members',
      }),
      cursorParam: z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,40}$/)
        .default('cursor')
        .meta({ 'x-label': 'Cursor parameter' }),
      cursorPointer: pointer.default('/cursor').meta({ 'x-label': 'Next cursor' }),
      itemsPointer: pointer.default('/items').meta({ 'x-label': 'Items' }),
      refPointer: pointer.default('/id').meta({ 'x-label': 'Item ID' }),
      recordPointer: pointer.default('').meta({ 'x-label': 'Item record' }),
      deletedPointer: pointer.optional().meta({ 'x-label': 'Deleted flag' }),
      hasMorePointer: pointer.optional().meta({ 'x-label': 'More pages flag' }),
    })
    .optional()
    .meta({ 'x-label': 'List endpoint' }),
  webhook: z
    .object({
      eventIdPointer: pointer.default('/id').meta({ 'x-label': 'Event ID' }),
      refsPointer: pointer.default('/refs').meta({ 'x-label': 'Record IDs' }),
      signatureHeader: z
        .string()
        .refine(isAllowedHeaderName)
        .default(SIGNATURE_HEADER)
        .meta({ 'x-label': 'Signature header' }),
      timestampHeader: z
        .string()
        .refine(isAllowedHeaderName)
        .default(TIMESTAMP_HEADER)
        .meta({ 'x-label': 'Timestamp header' }),
    })
    .default({
      eventIdPointer: '/id',
      refsPointer: '/refs',
      signatureHeader: SIGNATURE_HEADER,
      timestampHeader: TIMESTAMP_HEADER,
    })
    .meta({ 'x-label': 'Webhook' }),
});
/** `x-auth` names the auth types a secret belongs to, so the form shows only those. */
const secrets = z.object({
  token: z
    .string()
    .max(4096)
    .optional()
    .meta({ 'x-label': 'Token', 'x-auth': ['bearer'] }),
  username: z
    .string()
    .max(256)
    .optional()
    .meta({ 'x-label': 'Username', 'x-auth': ['basic'] }),
  password: z
    .string()
    .max(1024)
    .optional()
    .meta({ 'x-label': 'Password', 'x-auth': ['basic'] }),
  headerValue: z
    .string()
    .max(4096)
    .optional()
    .meta({ 'x-label': 'Header value', 'x-auth': ['header'] }),
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
  description: 'Fetch records from a JSON API.',
  capabilities: { poll: true, delta: true, webhook: true },
  webhookReferenceMode: 'refs-only',
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
    if (rawEmail !== undefined && rawEmail !== null && typeof rawEmail !== 'string') {
      throw new ConnectorError('INVALID_PAYLOAD');
    }
    const holderEmail =
      strictEmail(rawEmail) ??
      (typeof rawEmail === 'string' && rawEmail.trim() !== '' ? rawEmail : undefined);
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
