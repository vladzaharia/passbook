/**
 * Samsung does not document its own AUTH token lifetime (samsung-wallet.md R2). Queued or retried
 * deliveries can arrive minutes late, so the window is wide and the replay store carries the load.
 * Confirm with Samsung support; this is the only place the number lives.
 */
export const SAMSUNG_TOKEN_WINDOW_MS = 300_000;
export const SAMSUNG_CLOCK_SKEW_MS = 5_000;
/** Every outbound Samsung request is bounded; a timeout is an ambiguous network failure. */
export const SAMSUNG_REQUEST_TIMEOUT_MS = 10_000;
/**
 * How long a ref that served card data may wait for the ADDED that confirms it. Samsung previews
 * the card (and so calls Get Card Data) before the holder confirms, and a holder who cancels never
 * produces an ADDED. Our link and initial window last 5 minutes; the rest is margin for a holder
 * who leaves the preview open or a Send Card State that is retried after an outage of ours. Past
 * it a revoke stops waiting, so a pass can always be deleted and erased.
 */
export const SAMSUNG_UNCONFIRMED_SERVE_MS = 3_600_000;
