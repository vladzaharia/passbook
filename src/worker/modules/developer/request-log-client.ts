/** Product tokens worth naming, by what a User-Agent starts with. Anything else is stored as nothing. */
const KNOWN: readonly [RegExp, string][] = [
  [/^curl\/(\d{1,3}(?:\.\d{1,3}){0,2})/i, 'curl/$1'],
  [/^(?:node|undici|node-fetch)\b/i, 'node'],
  [/^python-requests\b/i, 'python-requests'],
  [/^python-httpx\b/i, 'python-httpx'],
  [/^aiohttp\b/i, 'python-aiohttp'],
  [/^go-http-client\b/i, 'go'],
  [/^(?:okhttp|java|apache-httpclient)\b/i, 'java'],
  [/^(?:ruby|faraday)\b/i, 'ruby'],
  [/^php\b|^guzzlehttp\b/i, 'php'],
  [/^postmanruntime\b/i, 'postman'],
  [/^insomnia\b/i, 'insomnia'],
  [/^httpie\b/i, 'httpie'],
  [/^wget\b/i, 'wget'],
  [/^deno\b/i, 'deno'],
  [/^bun\b/i, 'bun'],
  [/^passbook-(?:sdk|cli)\b/i, 'passbook-sdk'],
  [/^mozilla\//i, 'browser'],
];

/**
 * A short, fixed-vocabulary name for the client behind a User-Agent, or null. Only curl keeps a version. The
 * header is never stored: an unknown or empty one is null, so no free text reaches the log.
 */
export function clientOf(userAgent: string | undefined | null): string | null {
  const ua = (userAgent ?? '').trim().slice(0, 200);
  if (!ua) return null;
  for (const [pattern, name] of KNOWN) {
    const m = pattern.exec(ua);
    if (m) return name.replace('$1', m[1] ?? '');
  }
  return null;
}
