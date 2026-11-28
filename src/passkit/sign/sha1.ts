/** Hashing with no certificate code, so a browser can plan a pass without the signer. */

export function hex(buffer: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(buffer instanceof Uint8Array ? buffer : buffer), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-1', bytes as BufferSource));
}
