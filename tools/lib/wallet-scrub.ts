// Scrubs provider requests and responses before they are written as fixtures. Used only by the owner-run
// recorder (tools/record-wallet-contract.ts); tests never reach a provider.

const SECRET_KEY =
  /token|authorization|secret|private|password|assertion|signature|cookie|cdata|pdata|credential|api[-_]?key|e-?mail|phone|name|address|barcode|birth|holder|member|^value$|^body$|^uri$|^url$/i;
const KEEP_KEY = /^(issuerName|programName)$/i;

export interface ScrubContext {
  ids: Map<string, string>;
}

export const newScrubContext = (): ScrubContext => ({ ids: new Map() });

/** A stable placeholder per distinct id, so a fixture still shows which steps touched the same object. */
function alias(ctx: ScrubContext, kind: string, raw: string): string {
  const known = ctx.ids.get(raw);
  if (known) return known;
  const next = `<${kind}-${[...ctx.ids.values()].filter((v) => v.startsWith(`<${kind}-`)).length + 1}>`;
  ctx.ids.set(raw, next);
  return next;
}

export function scrubString(text: string, ctx: ScrubContext = newScrubContext()): string {
  return text
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '<pem>')
    .replace(/\beyJ[\w-]+\.[\w-]*\.?[\w-]*/g, '<jwt>')
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 <token>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/https?:\/\/[^\s"'\\]+/g, '<url>')
    .replace(
      /\b\d{10,}\.[\w.-]+/g,
      (m) => `<issuer>.${alias(ctx, 'id', m.split('.').slice(1).join('.'))}`,
    )
    .replace(/\b\d{10,}\b/g, '<number>')
    .replace(/\bya29\.[\w.-]+/g, '<token>');
}

export function scrubValue(
  value: unknown,
  ctx: ScrubContext = newScrubContext(),
  key = '',
): unknown {
  if (SECRET_KEY.test(key) && !KEEP_KEY.test(key))
    return value === undefined || value === null ? value : '<redacted>';
  if (typeof value === 'string') return scrubString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, ctx, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v, ctx, k)]));
  return value;
}

/** Response headers worth keeping for a contract: none that identify a caller or carry a credential. */
const KEPT_HEADERS = new Set(['content-type', 'retry-after', 'x-ratelimit-remaining']);
export function scrubHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  return Object.fromEntries(entries.filter(([k]) => KEPT_HEADERS.has(k.toLowerCase())));
}

/** Last line of defence: true when serialized output still holds something that looks like a secret. */
export function leaks(serialized: string): string[] {
  const found: string[] = [];
  if (/eyJ[\w-]{8,}\.[\w-]{4,}/.test(serialized)) found.push('jwt');
  if (/-----BEGIN/.test(serialized)) found.push('pem');
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(serialized)) found.push('email');
  if (/\bya29\./.test(serialized)) found.push('oauth token');
  if (/\bBearer\s+(?!<token>)\S+/i.test(serialized)) found.push('bearer');
  if (/https?:\/\//.test(serialized)) found.push('url');
  if (/\b\d{10,}\b/.test(serialized)) found.push('long number');
  return found;
}
