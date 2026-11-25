import { AppError } from '../../platform/errors.ts';
import type { SafeResponse } from '../../platform/safe-fetch.ts';
import { type ConnectorContext, ConnectorError } from '../types.ts';

const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'cookie',
  'set-cookie',
  'upgrade',
  'proxy-authorization',
  'te',
  // A GET that an upstream reads as a write.
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
]);

export const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

export function isAllowedHeaderName(name: string): boolean {
  return HEADER_NAME.test(name) && !FORBIDDEN_HEADERS.has(name.toLowerCase());
}

/** A ref is a single opaque path segment; anything that could change the path is refused. */
export function assertSafeRef(ref: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
  if (!ref || ref.length > 200 || ref.includes('..') || /[/\\?#\u0000-\u001f]/.test(ref)) {
    throw new ConnectorError('INVALID_PAYLOAD');
  }
  return encodeURIComponent(ref);
}

const MAX_WAIT_MS = 3_600_000;

/** A reset header as a wait in ms: whole seconds ahead, or an epoch in seconds or ms. At most an hour. */
function resetMs(raw: string | null, now: number): number | undefined {
  if (raw === null || !/^\d+(\.\d+)?$/.test(raw.trim())) return undefined;
  const n = Number(raw);
  const wait = n >= 1e12 ? n - now : n >= 1e9 ? n * 1000 - now : n * 1000;
  return wait > 0 ? Math.min(Math.ceil(wait), MAX_WAIT_MS) : undefined;
}

/** How long the API asks to wait: `Retry-After` (seconds or HTTP-date), else a rate-limit reset header. */
export function waitFromHeaders(headers: Headers, now: number): number | undefined {
  const retry = headers.get('retry-after')?.trim();
  if (retry) {
    if (/^\d+(\.\d+)?$/.test(retry)) {
      return Math.min(Math.ceil(Number(retry) * 1000), MAX_WAIT_MS) || undefined;
    }
    const at = Date.parse(retry);
    if (Number.isFinite(at) && at > now) return Math.min(at - now, MAX_WAIT_MS);
  }
  return resetMs(headers.get('ratelimit-reset') ?? headers.get('x-ratelimit-reset'), now);
}

/** The requests left in this window, when the API says. */
export function remainingFromHeaders(headers: Headers): number | undefined {
  const raw = headers.get('ratelimit-remaining') ?? headers.get('x-ratelimit-remaining');
  return raw !== null && /^\d+$/.test(raw.trim()) ? Number(raw) : undefined;
}

/** Maps transport failures and HTTP statuses to connector error codes. Bodies are never echoed. */
export async function request(
  ctx: ConnectorContext<unknown, unknown>,
  url: string,
  headers: Record<string, string>,
  options: { notFoundOk?: boolean } = {},
): Promise<SafeResponse | null> {
  let res: SafeResponse;
  try {
    res = await ctx.fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...headers },
      signal: ctx.signal,
    });
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === 'TIMEOUT') throw new ConnectorError('TIMEOUT');
      if (error.code === 'UNSAFE_URL') throw new ConnectorError('CONFIG', { permanent: true });
      throw new ConnectorError('UPSTREAM');
    }
    throw error;
  }
  const { status } = res;
  if (status >= 200 && status < 300) return res;
  if (status === 404 && options.notFoundOk) return null;
  if (status === 401) throw new ConnectorError('AUTH', { permanent: true, httpStatus: status });
  if (status === 403)
    throw new ConnectorError('FORBIDDEN', { permanent: true, httpStatus: status });
  if (status === 429) {
    const wait = waitFromHeaders(res.headers, ctx.now());
    throw new ConnectorError('RATE_LIMITED', {
      httpStatus: status,
      ...(wait ? { retryAfterMs: wait } : {}),
    });
  }
  throw new ConnectorError('UPSTREAM', { httpStatus: status });
}

export function parseJson(res: SafeResponse): unknown {
  try {
    return res.json();
  } catch {
    throw new ConnectorError('INVALID_PAYLOAD', { httpStatus: res.status });
  }
}
