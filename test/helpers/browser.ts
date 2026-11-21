const KEY_BEARER = /^Bearer\s+(?:wlt|pb|pbp|pbo)_/i;

/**
 * `{ origin }` for a browser call, nothing for an API key call: a key comes from a server, and a key sent with
 * `Origin` is refused as KEY_IN_BROWSER (platform/browser-signals.ts).
 */
export const originUnlessKey = (
  headers: Record<string, string>,
  origin: string,
): { origin?: string } => (KEY_BEARER.test(headers.authorization ?? '') ? {} : { origin });
