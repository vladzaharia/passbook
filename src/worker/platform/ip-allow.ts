import { ipv6Groups } from './ip.ts';

interface Net {
  v: 4 | 6;
  /** The address (or network) as an integer. */
  n: bigint;
  bits: number;
}

function addressOf(ip: string): { v: 4 | 6; n: bigint } | null {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const text = mapped?.[1] ?? ip;
  if (text.includes(':')) {
    const groups = ipv6Groups(text);
    return groups ? { v: 6, n: BigInt(`0x${groups.join('')}`) } : null;
  }
  const octets = text.split('.');
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255))
    return null;
  return { v: 4, n: octets.reduce((acc, o) => (acc << 8n) | BigInt(o), 0n) };
}

/** `203.0.113.0/24`, `2001:db8::/32` or a single address; null when malformed. Host bits must be zero. */
export function parseCidr(text: string): Net | null {
  const [addr, len, extra] = text.trim().split('/');
  if (!addr || extra !== undefined) return null;
  const a = addressOf(addr);
  if (!a) return null;
  const width = a.v === 4 ? 32 : 128;
  if (len !== undefined && !/^\d{1,3}$/.test(len)) return null;
  const bits = len === undefined ? width : Number(len);
  if (bits > width) return null;
  const hostMask = (1n << BigInt(width - bits)) - 1n;
  return (a.n & hostMask) === 0n ? { v: a.v, n: a.n, bits } : null;
}

/** Whether `ip` falls in any entry. An address that cannot be read matches nothing. */
export function ipAllowed(ip: string | undefined, cidrs: readonly string[]): boolean {
  const a = ip ? addressOf(ip) : null;
  if (!a) return false;
  const width = a.v === 4 ? 32 : 128;
  return cidrs.some((c) => {
    const net = parseCidr(c);
    return net?.v === a.v && a.n >> BigInt(width - net.bits) === net.n >> BigInt(width - net.bits);
  });
}
