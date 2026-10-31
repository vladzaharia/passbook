const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++)
    crc = (TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-1', bytes as BufferSource));
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** Stable JSON: object keys sorted, so equal documents hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface VersionInput {
  passJson: unknown;
  manifest: unknown;
  assets: readonly { name: string; sha1: string }[];
}

/** Content hash of everything that affects the built pass. 16 hex chars of SHA-256. */
export async function contentVersion(input: VersionInput): Promise<string> {
  const assets = input.assets
    .map((a) => `${a.name}:${a.sha1}`)
    .sort()
    .join('\n');
  const digest = await sha256Hex(
    `${canonicalJson(input.passJson)}\n${canonicalJson(input.manifest)}\n${assets}`,
  );
  return digest.slice(0, 16);
}
