import { UpstreamError, ValidationError } from './errors.ts';

export interface DnsResolver {
  /** Returns every A and AAAA address for the host. */
  resolve(host: string): Promise<string[]>;
}

export interface SafeFetchOptions {
  /** Hostnames of the platform itself (never reachable through connectors). */
  platformHosts?: string[];
  resolver?: DnsResolver;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface SafeResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
}

export type SafeFetch = (url: string, init?: SafeRequestInit) => Promise<SafeResponse>;
export type SafeRequestInit = Omit<RequestInit, 'redirect' | 'signal'> & { signal?: AbortSignal };

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 256 * 1024;

function ipv4ToInt(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

export function isIpLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  return (
    ipv4ToInt(bare) !== null ||
    bare.includes(':') ||
    /^\d+$/.test(bare) ||
    /^0x[0-9a-f]+$/i.test(bare)
  );
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and mapped-private addresses. */
export function isPrivateIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = ipv4ToInt(bare);
  if (v4) {
    const [a = 0, b = 0] = v4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (!bare.includes(':')) return true;
  const mapped = /^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (mapped?.[1]) return isPrivateIp(mapped[1]);
  return (
    bare === '::' ||
    bare === '::1' ||
    bare.startsWith('fe8') ||
    bare.startsWith('fe9') ||
    bare.startsWith('fea') ||
    bare.startsWith('feb') ||
    bare.startsWith('fc') ||
    bare.startsWith('fd') ||
    bare.startsWith('ff') ||
    bare.startsWith('64:ff9b') ||
    bare.startsWith('2001:db8') ||
    bare.startsWith('::ffff:')
  );
}

/** Static URL rules (spec section 9). Throws ValidationError; performs no network I/O. */
export function assertSafeUrl(raw: string, platformHosts: string[] = []): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('The URL is invalid.', [], 'UNSAFE_URL');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:')
    throw new ValidationError('Only https URLs are allowed.', [], 'UNSAFE_URL');
  if (url.port && url.port !== '443')
    throw new ValidationError('Only port 443 is allowed.', [], 'UNSAFE_URL');
  if (url.username || url.password)
    throw new ValidationError('URLs with credentials are not allowed.', [], 'UNSAFE_URL');
  if (isIpLiteral(host))
    throw new ValidationError('IP addresses are not allowed.', [], 'UNSAFE_URL');
  if (
    !host.includes('.') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost')
  ) {
    throw new ValidationError('The host is not allowed.', [], 'UNSAFE_URL');
  }
  if (platformHosts.some((p) => host === p.toLowerCase() || host.endsWith(`.${p.toLowerCase()}`))) {
    throw new ValidationError('The host is not allowed.', [], 'UNSAFE_URL');
  }
  // URL parsing normalizes dot segments away, so check the raw input.
  if (/(?:^|\/)(?:\.\.|%2e%2e)(?:[/?#]|$)/i.test(raw)) {
    throw new ValidationError('The URL path is not allowed.', [], 'UNSAFE_URL');
  }
  return url;
}

/** DNS-over-HTTPS resolver (Cloudflare). */
export function dohResolver(fetchImpl: typeof fetch = fetch): DnsResolver {
  const lookup = async (host: string, type: 'A' | 'AAAA'): Promise<string[]> => {
    const res = await fetchImpl(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      { headers: { accept: 'application/dns-json' } },
    );
    if (!res.ok) throw new UpstreamError('DNS lookup failed.', 'DNS_FAILED');
    const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
    const wanted = type === 'A' ? 1 : 28;
    return (body.Answer ?? []).filter((a) => a.type === wanted).map((a) => a.data);
  };
  return {
    resolve: async (host) => [...(await lookup(host, 'A')), ...(await lookup(host, 'AAAA'))],
  };
}

/** Throws when the host has no public addresses or any private one. Use at save time and before fetch. */
export async function assertPublicHost(host: string, resolver: DnsResolver): Promise<void> {
  const addresses = await resolver.resolve(host);
  if (addresses.length === 0)
    throw new ValidationError('The host does not resolve.', [], 'UNSAFE_URL');
  if (addresses.some(isPrivateIp))
    throw new ValidationError('The host resolves to a private address.', [], 'UNSAFE_URL');
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes)
    throw new UpstreamError('The upstream response is too large.', 'RESPONSE_TOO_LARGE');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UpstreamError('The upstream response is too large.', 'RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Outbound fetch for tenant-configured URLs: https/443 only, public hosts only, no redirects, capped. */
export function createSafeFetch(options: SafeFetchOptions = {}): SafeFetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolver = options.resolver ?? dohResolver(fetchImpl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  return async (raw, init = {}) => {
    const url = assertSafeUrl(raw, options.platformHosts);
    await assertPublicHost(url.hostname, resolver);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), { ...init, redirect: 'manual', signal });
    } catch {
      const timedOut = timeout.aborted;
      throw new UpstreamError(
        timedOut ? 'The upstream request timed out.' : 'The upstream request failed.',
        timedOut ? 'TIMEOUT' : 'UPSTREAM',
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new UpstreamError('The upstream redirected the request.', 'REDIRECT_BLOCKED');
    }
    const body = await readCapped(response, maxBytes);
    const decode = () => new TextDecoder().decode(body);
    return {
      status: response.status,
      headers: response.headers,
      body,
      text: decode,
      json: <T>() => JSON.parse(decode()) as T,
    };
  };
}
