/**
 * Samsung does not document its own AUTH token lifetime (samsung-wallet.md R2). Queued or retried
 * deliveries can arrive minutes late, so the window is wide and the replay store carries the load.
 * Confirm with Samsung support; this is the only place the number lives.
 */
export const SAMSUNG_TOKEN_WINDOW_MS = 300_000;
export const SAMSUNG_CLOCK_SKEW_MS = 5_000;
/** Every outbound Samsung request is bounded; a timeout is an ambiguous network failure. */
export const SAMSUNG_REQUEST_TIMEOUT_MS = 10_000;
