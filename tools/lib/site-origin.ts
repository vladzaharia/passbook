// The canonical origin (vars.PUBLIC_BASE_URL in wrangler.jsonc) for what is built or printed
// outside the Worker: index.html's preview tags and the break-glass sign-in URL.
import { readJsonc } from './jsonc.ts';

/** index.html writes its absolute URLs as `%PUBLIC_BASE_URL%/…`; vite.config.ts fills them in. */
export const ORIGIN_TOKEN = '%PUBLIC_BASE_URL%';

export function publicBaseUrl(wranglerPath: string): string {
  const base = readJsonc<{ vars?: Record<string, unknown> }>(wranglerPath).vars?.PUBLIC_BASE_URL;
  if (typeof base !== 'string' || !/^https?:\/\/[^/]+/.test(base))
    throw new Error(`${wranglerPath}: vars.PUBLIC_BASE_URL is not an origin.`);
  return base.replace(/\/+$/, '');
}

export const withOrigin = (html: string, base: string) => html.replaceAll(ORIGIN_TOKEN, base);
