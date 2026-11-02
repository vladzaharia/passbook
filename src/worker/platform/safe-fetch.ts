import { UpstreamError, ValidationError } from './errors.ts';
import { readCapped } from './read-capped.ts';

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
    const [a = 0, b = 0, c = 0] = v4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) || // 192.0.0.0/24 and 192.0.2.0/24
      (a === 192 && b === 88 && c === 99) || // 192.88.99.0/24 6to4 relay
      (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 documentation
      (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 documentation
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (!bare.includes(':')) return true;
  const h = expandIpv6(bare);
  if (!h) return true;
  const [h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0] = h;
  const embedded = `${h6 >> 8}.${h6 & 255}.${h7 >> 8}.${h7 & 255}`;
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible) carry an IPv4 address.
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && (h5 === 0xffff || h5 === 0))
    return h5 === 0 && h6 === 0 && h7 <= 1 ? true : isPrivateIp(embedded);
  return (
    (h0 & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (h0 & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (h0 & 0xff00) === 0xff00 || // ff00::/8 multicast
    (h0 === 0x64 && h1 === 0xff9b) || // 64:ff9b::/96 and 64:ff9b:1::/48 NAT64
    (h0 === 0x100 && h1 === 0 && h2 === 0 && h3 === 0) || // 100::/64 discard
    (h0 === 0x2001 && h1 === 0) || // 2001::/32 Teredo
    (h0 === 0x2001 && h1 === 0xdb8) || // documentation
    h0 === 0x2002 // 2002::/16 6to4
  );
}

/** Eight 16-bit groups, or null when the text is not a valid IPv6 address. */
function expandIpv6(text: string): number[] | null {
  let ip = text.split('%')[0] ?? '';
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
  if (tail) {
    const v4 = ipv4ToInt(tail);
    if (!v4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    ip = `${ip.slice(0, -tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array<string>(Math.max(fill, 0)).fill('0'), ...rest];
  if (groups.length !== 8 || fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  return nums.every((n) => !Number.isNaN(n)) ? nums : null;
}

/** Hostnames of the platform itself, plus the SSRF_DENY_HOSTS list. Never reachable through connectors. */
export function platformHostsOf(env: {
  PUBLIC_BASE_URL: string;
  OIDC_ISSUER?: string;
  SSRF_DENY_HOSTS?: string;
}): string[] {
  const hostOf = (raw: string | undefined) => {
    try {
      return raw ? new URL(raw).hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  };
  const listed = (env.SSRF_DENY_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [
    ...new Set(
      [hostOf(env.PUBLIC_BASE_URL), hostOf(env.OIDC_ISSUER), 'workers.dev', ...listed].filter(
        (h): h is string => Boolean(h),
      ),
    ),
  ];
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
    const body = await readCapped(
      response.body,
      maxBytes,
      () => new UpstreamError('The upstream response is too large.', 'RESPONSE_TOO_LARGE'),
      Number(response.headers.get('content-length') ?? 0),
    );
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
