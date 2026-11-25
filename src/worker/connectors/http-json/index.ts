import type { Json } from '../../../shared/contracts/common.ts';
import { strictEmail } from '../../../shared/email.ts';
import { parseJsonBody } from '../lib/decode.ts';
import { verifySignedRequest, webhookSecretsOf } from '../lib/hmac.ts';
import { getPointer } from '../lib/pointer.ts';
import { type ConnectorDefinition, ConnectorError, type UpstreamRecord } from '../types.ts';
import { type Config, config, type Secrets, secrets } from './config.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { highest, maxOf, sinceParam } from './incremental.ts';
import { migrate } from './migrate.ts';
import { advance, pageUrl } from './pagination.ts';
import { exhaustedUntil, holdUntil } from './rate-limit.ts';
import { assertCredential, authParamOf, endpoint, getJson } from './request.ts';

const MAX_WEBHOOK_REFS = 100;
/** Records per page; a longer page is refused rather than cut, because a cut page breaks paging. */
const MAX_PAGE_RECORDS = 1000;
/** Serialized changes of one page; the Workflows step result limit is 1 MiB. */
const MAX_PAGE_JSON = 900_000;
const ref80 = (r: string) => r.slice(0, 80);
const note = (pages: number) =>
  `MAX_PAGES: stopped at ${pages} pages; the next run continues. Raise the page limit or set a larger page size.`;

function asRecord(value: Json | undefined): UpstreamRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value === undefined) {
    throw new ConnectorError('INVALID_PAYLOAD');
  }
  return value;
}

function changeOf(item: Json, list: NonNullable<Config['list']>) {
  const rawRef = getPointer(item, list.idPointer);
  if (typeof rawRef !== 'string' && typeof rawRef !== 'number') {
    throw new ConnectorError('INVALID_PAYLOAD');
  }
  const deleted = list.deletedPointer ? getPointer(item, list.deletedPointer) === true : false;
  const embedded = getPointer(item, list.recordPointer);
  const isObject = embedded !== null && typeof embedded === 'object' && !Array.isArray(embedded);
  return {
    ref: String(rawRef),
    ...(deleted ? { deleted: true } : {}),
    ...(!deleted && isObject ? { record: embedded as UpstreamRecord } : {}),
  };
}

/** REST API: per-record GET, an optional paged list (full or feed) and an optional signed webhook. */
const definition: ConnectorDefinition<Config, Secrets> = {
  type: 'http-json',
  version: 2,
  displayName: 'REST API',
  description: 'Read records from a REST API.',
  category: 'apis',
  order: 10,
  capabilities: { poll: true, delta: true, webhook: true },
  webhookReferenceMode: 'refs-only',
  configSchema: config,
  secretSchema: secrets,
  outputFields: {},
  urls: (c) => [c.baseUrl],
  egress: (c) => [new URL(c.baseUrl).origin],
  hasList: (c) => c.list !== undefined,
  migrate,
  defaults: {
    intervalSeconds: 900,
    maxConcurrency: 4,
    requestsPerMinute: 60,
    timeoutMs: 15_000,
    // Half the Workflows 1 MiB step-result limit: a page's changes are the result of one step.
    maxResponseBytes: 512 * 1024,
  },

  async test(ctx) {
    const { config: c } = ctx.connection;
    if (c.list) {
      const page = await getJson(ctx, pageUrl(new URL(c.baseUrl), c.list, null));
      if (!Array.isArray(getPointer(page?.body, c.list.recordsPointer))) {
        throw new ConnectorError('INVALID_PAYLOAD');
      }
      return { ok: true, detail: 'List endpoint reachable.' };
    }
    if (c.testRef && c.recordPath) {
      const page = await getJson(ctx, endpoint(c.baseUrl, c.recordPath, c.testRef), true);
      return {
        ok: true,
        detail: page === null ? 'Reachable; test record not found.' : 'Record fetched.',
      };
    }
    assertCredential(ctx);
    return { ok: true, detail: 'Config valid; no test target set.' };
  },

  async fetchRecord(ctx, ref) {
    const { config: c } = ctx.connection;
    // A list-only connection has no per-record fetch; a ref that needs one is a config problem.
    if (!c.recordPath) throw new ConnectorError('CONFIG', { permanent: true });
    const page = await getJson(ctx, endpoint(c.baseUrl, c.recordPath, ref), true);
    if (page === null) return { status: 'not_found' };
    const { body } = page;
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

  /**
   * One page per call. The cursor carries the page state, the high-water mark and any wait the API asked
   * for. The core saves it only after the page is applied, so a failed run resumes from the same page.
   */
  async listChanges(ctx, cursor) {
    const { list, baseUrl } = ctx.connection.config;
    if (!list) throw new ConnectorError('CONFIG', { permanent: true });
    const { state, damaged } = decodeCursor(cursor);
    if (damaged) ctx.log('rest.cursor_reset');
    await holdUntil(state.w, ctx.now(), ctx.signal);

    const base = new URL(baseUrl);
    const inc = list.incremental;
    const since = inc ? sinceParam(inc, state.h) : undefined;
    const page = await getJson(ctx, pageUrl(base, list, state.p, since));
    if (page === null) throw new ConnectorError('UPSTREAM');
    const items = getPointer(page.body, list.recordsPointer);
    if (!Array.isArray(items) || items.length > MAX_PAGE_RECORDS) {
      throw new ConnectorError('INVALID_PAYLOAD');
    }
    const changes = items.map((item) => changeOf(item, list));
    if (JSON.stringify(changes).length > MAX_PAGE_JSON) {
      throw new ConnectorError('INVALID_PAYLOAD', { permanent: true, reason: 'PAGE_TOO_LARGE' });
    }

    const config = ctx.connection.config;
    const step = advance(list, state.p, { ...page, items }, base, {
      param: authParamOf(config),
      secret: ctx.secrets.queryValue,
    });
    const w = exhaustedUntil(page.headers, ctx.now());
    const m = inc ? highest(items, inc, state.m, ctx.now()) : undefined;
    const pages = (state.p?.k ?? 0) + 1;
    // The same first and last record as the page before: the API ignores our paging.
    const first = changes[0];
    const last = changes.at(-1);
    const sig = first && last ? `${ref80(first.ref)}|${ref80(last.ref)}` : undefined;
    const repeated = step.more && sig !== undefined && state.p?.s === sig;
    if (repeated) ctx.log('rest.repeat_page', { pages });
    const capped = step.more && !repeated && pages >= list.maxPages;
    if (capped) ctx.log('rest.max_pages', { pages });
    const keep = { ...(w === undefined ? {} : { w }) };
    const h = state.h;
    const hold = h === undefined ? {} : { h };
    const seen = m === undefined ? {} : { m };

    if (step.more && !capped && !repeated && step.next) {
      const p = { ...step.next, k: pages, ...(sig === undefined ? {} : { s: sig }) };
      return { changes, cursor: encodeCursor({ p, ...hold, ...seen, ...keep }), hasMore: true };
    }
    if (list.listing === 'full') {
      // A listing cut at maxPages carries on from the next page on the next run, with the mark held,
      // so it finishes; a repeating one starts over, because carrying on would loop.
      if (capped)
        return {
          changes,
          cursor: encodeCursor({ p: step.next, ...hold, ...seen, ...keep }),
          hasMore: false,
          note: note(pages),
        };
      const end = repeated ? h : maxOf(h, m);
      return {
        changes,
        cursor: encodeCursor({ p: null, ...(end === undefined ? {} : { h: end }), ...keep }),
        hasMore: false,
      };
    }
    return {
      changes,
      cursor: encodeCursor({ p: capped ? step.next : step.rest, ...keep }),
      hasMore: false,
      ...(capped ? { note: note(pages) } : {}),
    };
  },

  async verifyWebhook(ctx, req) {
    const { webhook } = ctx.connection.config;
    const { body, signature, usedPrevious } = await verifySignedRequest(req, {
      secrets: webhookSecretsOf(ctx),
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
    return { eventId, refs, ...(usedPrevious ? { usedPreviousSecret: true as const } : {}) };
  },
};
export default definition;
