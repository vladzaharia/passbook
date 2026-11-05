/** The roster hash: the first 128 bits (32 hex) of SHA-256 of the trimmed code (AC 6.4). */

export async function rosterHash(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code.trim()));
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
