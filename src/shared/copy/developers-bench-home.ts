/** The Workbench home's own words; the shared bench words live in developers-bench.ts. */
export const BENCH_HOME_COPY = {
  testOnly: 'Test only',
  previewsOnly: 'Previews only',
  closed: 'Closed',
  newKeyTitle: 'Sandbox key',
  states: { rolling: 'Rolling', expired: 'Expired', paused: 'Paused', disabled: 'Disabled' },
  hook: { ok: 'OK', failed: 'Failed', none: 'Nothing yet' },
  key: { used: 'Used', unused: 'Not used', expires: 'Expires' },
  closedLine: { ago: 'Closed', reopen: 'Reopen', gone: 'It can no longer reopen.' },
} as const;
