/** Words of the Webhooks tool on the Workbench. Terse; the frame's own words are in developers-bench.ts. */
export const BENCH_WEBHOOKS_COPY = {
  send: { action: 'Send test event', as: 'Send as' },
  tabs: { headers: 'Headers', body: 'Body', verify: 'Verify' },
  inspector: {
    replay: 'Replay',
    headers: 'Request headers',
    noHeaders: 'No headers kept',
    body: 'Request body',
    noBody: 'No body',
    stored: 'Stored, not sent. Nothing left PassBook.',
  },
} as const;
