/** Eight 16-bit groups of an IPv6 address (`::` expanded, lowercase), or null if malformed. */
function ipv6Groups(ip: string): string[] | null {
  let addr = ip.toLowerCase().split('%')[0] ?? '';
  const tail = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail?.[1]) {
    const o = tail[1].split('.').map(Number);
    if (o.length !== 4 || o.some((n) => !(n >= 0 && n <= 255))) return null;
    const hex = (a: number, b: number) => ((a << 8) | b).toString(16);
    addr = `${addr.slice(0, -tail[1].length)}${hex(o[0] ?? 0, o[1] ?? 0)}:${hex(o[2] ?? 0, o[3] ?? 0)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array<string>(Math.max(fill, 0)).fill('0'), ...rest];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, '0'));
}

function prefixOf(ip: string | undefined, v6Groups: number, v6Bits: number): string | null {
  if (!ip || ip === 'unknown') return null;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped?.[1]) return prefixOf(mapped[1], v6Groups, v6Bits);
  if (ip.includes(':')) {
    const groups = ipv6Groups(ip);
    if (!groups) return null;
    const kept = groups.slice(0, v6Groups).join(':');
    return `${kept}${v6Groups < 8 ? '::' : ''}/${v6Bits}`;
  }
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts.slice(0, 3).join('.')}.0/24` : null;
}

/** v4 /24, v6 /48: enough for audit and session lists without storing full addresses. */
export const ipPrefix = (ip: string | undefined): string | null => prefixOf(ip, 3, 48);

/** v4 /24, v6 /64 (one subscriber's LAN): the unit rate limits and budgets are keyed by. */
export const ipRatePrefix = (ip: string | undefined): string | null => prefixOf(ip, 4, 64);

/**
 * The default rate-limit unit: the full IPv4 address, or the IPv6 /64 (one subscriber's LAN, which
 * holds 2^64 addresses). A /24 here would pool the carrier NAT behind a venue.
 */
export function ipBucket(ip: string | undefined): string | null {
  if (!ip || ip === 'unknown') return null;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped?.[1]) return mapped[1];
  if (ip.includes(':')) return ipRatePrefix(ip);
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
}
