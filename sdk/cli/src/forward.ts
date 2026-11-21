import type { Capture } from './api.ts';

/** Headers a client sets itself; forwarding them would only confuse the receiver's server. */
const SKIP = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'accept-encoding',
]);

export interface Forwarded {
  /** The receiver's status, or null when it could not be reached. */
  status: number | null;
  ms: number;
  error?: string;
}

/** `localhost:3000/hooks` and `http://localhost:3000/hooks` both name a receiver; anything else is refused. */
export function receiverUrl(text: string): string {
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(`--forward-to must be an http or https URL, got ${url.protocol}`);
  return url.toString();
}

/**
 * POSTs the capture to the receiver exactly as PassBook would have: the stored body text and the stored
 * headers, signature included, so the receiver's verification runs unchanged.
 */
export async function forward(
  capture: Capture,
  url: string,
  fetchImpl: typeof fetch = fetch,
  clock: () => number = Date.now,
): Promise<Forwarded> {
  const headers = Object.fromEntries(
    Object.entries(capture.headers).filter(([name]) => !SKIP.has(name.toLowerCase())),
  );
  const started = clock();
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: capture.body,
      redirect: 'manual',
    });
    await res.arrayBuffer();
    return { status: res.status, ms: clock() - started };
  } catch (cause) {
    const reason = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause;
    return {
      status: null,
      ms: clock() - started,
      error: reason instanceof Error ? reason.message : String(reason),
    };
  }
}
