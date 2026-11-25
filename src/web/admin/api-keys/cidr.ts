const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
const GROUP = /^[0-9a-f]{1,4}$/i;

/** An IPv4 or IPv6 address, with an optional prefix length. The server stays the authority. */
export function isIpOrCidr(value: string): boolean {
  const v4 = V4.exec(value);
  if (v4) {
    const octets = v4.slice(1, 5).map(Number);
    return octets.every((n) => n <= 255) && (v4[5] === undefined || Number(v4[5]) <= 32);
  }
  const [addr, prefix, extra] = value.split('/');
  if (extra !== undefined || !addr?.includes(':')) return false;
  if (prefix !== undefined && !(/^\d{1,3}$/.test(prefix) && Number(prefix) <= 128)) return false;
  const gaps = addr.split('::');
  if (gaps.length > 2) return false;
  const groups = addr.split(/::|:/).filter((g) => g !== '');
  const limit = gaps.length === 2 ? 7 : 8;
  if (gaps.length === 1 ? groups.length !== 8 : groups.length > limit) return false;
  return groups.every((g) => GROUP.test(g));
}

/** Splits pasted or typed text on whitespace and commas. */
export function splitIps(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}
