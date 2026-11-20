export interface SunUrl {
  slug: string;
  p: string;
  m: string;
}

const SLUG = /^\/t\/([A-Za-z0-9_-]{1,64})$/;
const P = /^[0-9a-fA-F]{32}$/;
const M = /^[0-9a-fA-F]{16}$/;

/** `https://<origin>/t/{slug}?p=<32 hex>&m=<16 hex>` -> its parts, or null for anything else. */
export function parseSunUrl(value: string): SunUrl | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const slug = SLUG.exec(url.pathname)?.[1];
  const p = url.searchParams.get('p');
  const m = url.searchParams.get('m');
  if (!slug || !p || !m || !P.test(p) || !M.test(m)) return null;
  return { slug, p, m };
}
