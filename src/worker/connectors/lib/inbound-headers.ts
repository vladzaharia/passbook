/** The custom scheme's header names: `x-wallet-*` is what connections are configured with; `x-passbook-*` (the outbound webhooks' spelling) is accepted too. */
export const SIGNATURE_HEADER = 'x-wallet-signature';
export const TIMESTAMP_HEADER = 'x-wallet-timestamp';
export const SIGNATURE_HEADERS = ['x-passbook-signature', SIGNATURE_HEADER] as const;
export const TIMESTAMP_HEADERS = ['x-passbook-timestamp', TIMESTAMP_HEADER] as const;

/** The first of `names` the request carries. A connection's own header name wins alone, unless it is one of `names`. */
export function inboundHeader(
  req: Request,
  names: readonly string[],
  configured?: string,
): string | null {
  if (configured && !names.includes(configured)) return req.headers.get(configured);
  for (const name of names) {
    const value = req.headers.get(name);
    if (value !== null) return value;
  }
  return null;
}
