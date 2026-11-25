import { assertSafeRef, parseJson, request } from '../lib/http.ts';
import { type ConnectorContext, ConnectorError } from '../types.ts';
import type { Config, Secrets } from './config.ts';
import { INLINE_RETRY_MS, sleep } from './rate-limit.ts';

export type Ctx = ConnectorContext<Config, Secrets>;

export function endpoint(base: string, template: string, ref?: string): URL {
  const url = new URL(base);
  const encoded = ref === undefined ? template : template.replace('{ref}', assertSafeRef(ref));
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${encoded}`;
  return url;
}

/** The credential as a header or a query pair; a permanent CONFIG error when it is incomplete. */
function credential({ connection, secrets: s }: Ctx): {
  header?: [string, string];
  query?: [string, string];
} {
  const { auth } = connection.config;
  if (auth.type === 'none') return {};
  if (auth.type === 'bearer' && s.token) return { header: ['authorization', `Bearer ${s.token}`] };
  if (auth.type === 'basic' && s.username !== undefined && s.password !== undefined) {
    return { header: ['authorization', `Basic ${btoa(`${s.username}:${s.password}`)}`] };
  }
  if (auth.type === 'header' && auth.headerName && s.headerValue) {
    return { header: [auth.headerName, s.headerValue] };
  }
  if (auth.type === 'query' && auth.queryParam && s.queryValue) {
    return { query: [auth.queryParam, s.queryValue] };
  }
  throw new ConnectorError('CONFIG', { permanent: true });
}

/** The name of the query parameter that carries the credential, if any. */
export const authParamOf = (c: Config): string | undefined =>
  c.auth.type === 'query' ? c.auth.queryParam : undefined;

/** Static headers first, the credential last, so a static header can never replace it. */
function headersOf(ctx: Ctx, header?: [string, string]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of ctx.connection.config.headers) out[name] = value;
  if (header) out[header[0]] = header[1];
  return out;
}

export interface Fetched {
  url: URL;
  body: unknown;
  headers: Headers;
}

/** One GET with the credential attached. A short 429 is retried once; a longer one is the caller's to schedule. */
export async function getJson(ctx: Ctx, url: URL, notFoundOk = false): Promise<Fetched | null> {
  const { header, query } = credential(ctx);
  const target = new URL(url);
  if (query) target.searchParams.set(query[0], query[1]);
  const headers = headersOf(ctx, header);
  const base = ctx as ConnectorContext<unknown, unknown>;
  const attempt = () => request(base, target.toString(), headers, { notFoundOk });
  let res: Awaited<ReturnType<typeof attempt>>;
  try {
    res = await attempt();
  } catch (error) {
    const wait = error instanceof ConnectorError ? error.retryAfterMs : undefined;
    if (
      !(error instanceof ConnectorError) ||
      error.code !== 'RATE_LIMITED' ||
      wait === undefined ||
      wait > INLINE_RETRY_MS
    ) {
      throw error;
    }
    await sleep(wait, ctx.signal);
    res = await attempt();
  }
  if (res === null) return null;
  // The stored URL never holds the credential.
  const shown = new URL(url);
  return { url: shown, body: parseJson(res), headers: res.headers };
}

/** Checks that the credential is complete without making a request. */
export function assertCredential(ctx: Ctx): void {
  credential(ctx);
}
