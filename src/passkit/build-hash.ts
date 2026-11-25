import type { PassJson } from './types.ts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((k) => record[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of pass.json content plus asset digests (`contentHash`). Independent of signing time. */
export function contentHashOf(
  passJson: PassJson,
  assetSha1: Record<string, string>,
): Promise<string> {
  return sha256Hex(
    `${canonical(passJson)}\n${Object.keys(assetSha1)
      .sort()
      .map((name) => `${name}:${assetSha1[name]}`)
      .join('\n')}`,
  );
}
