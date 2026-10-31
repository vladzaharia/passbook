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

function retryAfterMs(res: SafeResponse): number | undefined {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : undefined;
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
    const wait = retryAfterMs(res);
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
