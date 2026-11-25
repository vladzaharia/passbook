import type { z } from 'zod';
import type {
  ProbeErrorCodeSchema,
  ProbeResultSchema,
} from '../../../shared/contracts/connection-probe.ts';
import { detectResponse } from '../../../shared/rest/detect.ts';
import { PROBE_LIMITS, prune } from '../../../shared/rest/prune.ts';
import type { Config, Secrets } from '../../connectors/http-json/config.ts';
import { advance, pageUrl, repeatOf } from '../../connectors/http-json/pagination.ts';
import { authParamOf, endpoint, getJson } from '../../connectors/http-json/request.ts';
import { getPointer } from '../../connectors/lib/pointer.ts';
import { type ConnectorContext, ConnectorError } from '../../connectors/types.ts';
import { AppError } from '../../platform/errors.ts';
import type { SafeFetch } from '../../platform/safe-fetch.ts';
import type { Masker } from './probe-mask.ts';
import { decodeToken, encodeToken, idHash, type TokenKit } from './probe-token.ts';

type Ctx = ConnectorContext<Config, Secrets>;
type Code = z.infer<typeof ProbeErrorCodeSchema>;
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export interface ProbeRequest {
  target: 'list' | 'record';
  ref?: string | undefined;
  next?: string | undefined;
}

/** A page of more records than this is refused, as a sync refuses it: a cut page would break paging. */
const MAX_PAGE_RECORDS = 1000;
/** The whole answer stays under this, whatever the upstream sends. */
const MAX_RESULT_CHARS = 1_000_000;
const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Seen {
  status: number;
  bytes: number;
  contentType: string | null;
}
interface State {
  seen: Seen | null;
  refused: string | null;
  url: string | null;
}

const REFUSED: Record<string, Code> = {
  TIMEOUT: 'TIMEOUT',
  UNSAFE_URL: 'UNSAFE_URL',
  REDIRECT_BLOCKED: 'REDIRECT_BLOCKED',
  RESPONSE_TOO_LARGE: 'TOO_LARGE',
};

/** The one code a failure maps to; an error that is not the connector's own is not ours to describe. */
function codeOf(error: unknown, state: State): { code: Code; retryAfterMs?: number } {
  if (state.refused) return { code: REFUSED[state.refused] ?? 'UPSTREAM' };
  // A body too deep or too wide for the engine to hold is an oversized answer, not a bug.
  if (error instanceof RangeError) return { code: 'TOO_LARGE' };
  if (!(error instanceof ConnectorError)) throw error;
  if (error.reason === 'OFF_ORIGIN') return { code: 'OFF_ORIGIN' };
  switch (error.code) {
    case 'AUTH':
    case 'FORBIDDEN':
    case 'TIMEOUT':
      return { code: error.code };
    case 'RATE_LIMITED':
      return {
        code: 'RATE_LIMITED',
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      };
    case 'UPSTREAM':
      return { code: state.seen?.status === 404 ? 'NOT_FOUND' : 'UPSTREAM' };
    case 'INVALID_PAYLOAD':
      return { code: state.seen && state.seen.status < 300 ? 'NOT_JSON' : 'CONFIG' };
    default:
      return { code: 'CONFIG' };
  }
}

/**
 * Fetches one page (or one record) the way a sync does, through the connector's pinned `ctx.fetch`, and returns what
 * the explorer needs. The connector's own request builder, pagination and size caps run; only a 2xx JSON body is
 * returned, pruned and with the request's credentials masked, and nothing is stored or logged.
 */
export async function runProbe(
  cc: Ctx,
  req: ProbeRequest,
  mask: Masker,
  tokens: TokenKit,
): Promise<ProbeResult> {
  const started = cc.now();
  const state: State = { seen: null, refused: null, url: null };
  const fetchRecorded: SafeFetch = async (url, init) => {
    try {
      const res = await cc.fetch(url, init);
      state.seen = {
        status: res.status,
        bytes: res.body.byteLength,
        contentType: res.headers.get('content-type'),
      };
      return res;
    } catch (error) {
      if (error instanceof AppError) state.refused = error.code;
      throw error;
    }
  };
  const ctx: Ctx = { ...cc, fetch: fetchRecorded };
  const config = cc.connection.config;
  const requestOf = (): ProbeResult['request'] =>
    state.seen && state.url
      ? {
          method: 'GET',
          url: mask.url(state.url),
          status: state.seen.status,
          bytes: state.seen.bytes,
          contentType: state.seen.contentType
            ? mask.text(state.seen.contentType).slice(0, 200)
            : null,
        }
      : null;
  const failed = (code: Code, retryAfterMs?: number): ProbeResult => ({
    ok: false,
    errorCode: code,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    durationMs: cc.now() - started,
    request: requestOf(),
    headers: {},
    pruned: null,
    detections: null,
    page: null,
  });

  try {
    const list = config.list;
    const base = new URL(config.baseUrl);
    const prev = req.next === undefined ? null : await decodeToken(req.next, tokens);
    if (req.next !== undefined && !prev) return failed('CONFIG');
    // A token also stays under the configured base path: it cannot reach elsewhere on the origin.
    const under = base.pathname.replace(/\/+$/, '');
    const at = prev?.p?.u;
    if (at !== undefined && under !== '' && !new RegExp(`^${escapeRe(under)}(?:[/?#]|$)`).test(at))
      return failed('CONFIG');
    let url: URL;
    if (req.target === 'list') {
      if (!list) return failed('CONFIG');
      url = pageUrl(base, list, prev?.p ?? null);
    } else {
      const ref = req.ref ?? config.testRef;
      if (!config.recordPath || !ref) return failed('CONFIG');
      url = endpoint(config.baseUrl, config.recordPath, ref);
    }
    state.url = url.toString();
    const fetched = await getJson(ctx, url);
    if (!fetched) return failed('NOT_FOUND');

    const extraHeaders =
      list?.pagination.style === 'page' && list.pagination.totalPagesHeader
        ? [list.pagination.totalPagesHeader]
        : [];
    const headers = mask.headers(fetched.headers, extraHeaders);
    const { value: body, pruned } = prune(fetched.body, PROBE_LIMITS, mask.text);
    const shownUrl = mask.url(url.toString());
    const done = (extra: Pick<ProbeResult, 'ok' | 'page'> & { errorCode?: Code }): ProbeResult => {
      const found =
        req.target === 'list'
          ? detectResponse({
              body,
              headers,
              url: shownUrl,
              ...(list ? { recordsPointer: list.recordsPointer, idPointer: list.idPointer } : {}),
            })
          : detectResponse({ body, headers, url: shownUrl, record: config.recordPointer });
      // Detection saw the pruned body: counts come from what pruning cut.
      const total = (pointer: string, count: number) =>
        pruned.arrays.find((a) => a.pointer === pointer)?.total ?? count;
      const out: ProbeResult = {
        ...extra,
        durationMs: cc.now() - started,
        request: requestOf(),
        headers,
        body: body as ProbeResult['body'],
        pruned,
        detections: {
          ...found,
          records: found.records.map((r) => ({ ...r, count: total(r.pointer, r.count) })),
        },
      };
      return JSON.stringify(out).length > MAX_RESULT_CHARS ? failed('TOO_LARGE') : out;
    };
    if (req.target === 'record' || !list) return done({ ok: true, page: null });

    const items = getPointer(fetched.body, list.recordsPointer);
    if (!Array.isArray(items)) return done({ ok: false, errorCode: 'NO_RECORDS', page: null });
    if (items.length > MAX_PAGE_RECORDS) return failed('TOO_LARGE');
    const ids = items.map((item) => getPointer(item, list.idPointer));
    const hashes = ids.map(idHash).filter((h): h is string => h !== null);
    const seenBefore = new Set(prev?.ids ?? []);
    const overlap = hashes.filter((h) => seenBefore.has(h)).length;
    const index = (prev?.k ?? 0) + 1;
    const before = prev?.n ?? 0;
    let step: ReturnType<typeof advance>;
    try {
      step = advance(
        list,
        prev?.p ?? null,
        { url: fetched.url, body: fetched.body, headers: fetched.headers, items },
        base,
        { param: authParamOf(config), secret: cc.secrets.queryValue },
      );
    } catch (error) {
      if (error instanceof ConnectorError && error.reason === 'OFF_ORIGIN') {
        return done({
          ok: false,
          errorCode: 'OFF_ORIGIN',
          page: {
            index,
            from: before + Math.min(items.length, 1),
            to: before + items.length,
            overlap,
            next: null,
          },
        });
      }
      throw error;
    }
    const refs = ids.filter((v) => typeof v === 'string' || typeof v === 'number').map(String);
    const { repeated, stored } = await repeatOf(refs, prev?.p?.s, step.more);
    const next =
      step.more && !repeated && step.next && index < list.maxPages
        ? await encodeToken(
            {
              p: {
                ...step.next,
                ...(step.next.c === undefined ? {} : { c: mask.text(step.next.c) }),
                ...(step.next.u === undefined ? {} : { u: mask.text(step.next.u) }),
                ...(stored === undefined ? {} : { s: stored }),
              },
              k: index,
              n: before + items.length,
              ids: hashes,
            },
            tokens,
          )
        : null;
    return done({
      ok: true,
      page: {
        index,
        from: before + Math.min(items.length, 1),
        to: before + items.length,
        overlap,
        next,
      },
    });
  } catch (error) {
    const { code, retryAfterMs } = codeOf(error, state);
    return failed(code, retryAfterMs);
  }
}
