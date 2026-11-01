/** v4 /24, v6 /48: enough for audit and session lists without storing full addresses. */
export function ipPrefix(ip: string | undefined): string | null {
  if (!ip || ip === 'unknown') return null;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::/48`;
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts.slice(0, 3).join('.')}.0/24` : null;
}
