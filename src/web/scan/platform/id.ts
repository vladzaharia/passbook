/** Browser UUIDv7: timestamp prefix and cryptographically random uniqueness. */
export function scanId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let at = Date.now();
  for (let i = 5; i >= 0; i--) {
    bytes[i] = at % 256;
    at = Math.floor(at / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 15) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 0x80;
  const s = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
