const plural = (n: number, one: string, many: string) =>
  `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ${n === 1 ? one : many}`;

/** Words on the Logs tool of the Workbench. Terse. */
export const LOGS_BENCH_COPY = {
  list: 'Requests',
  count: (n: number, more: boolean) => (more ? `${n}+ requests` : plural(n, 'request', 'requests')),
  retention: 'Sandbox calls only. Kept 7 days; bodies 24 hours, redacted.',
  search: 'Search paths',
  toolbar: 'Filter requests',
  select: 'Select a request',
  filters: {
    status: 'Status',
    method: 'Method',
    code: 'Code',
    key: 'Key',
    source: 'Source',
    yours: 'Yours',
  },
  statusOptions: [
    { value: '2xx', label: '2xx' },
    { value: '4xx', label: '4xx' },
    { value: '5xx', label: '5xx' },
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  /** Yours is the default (off); the others widen the view. */
  sources: [
    { value: 'try', label: 'Portal' },
    { value: 'all', label: 'All' },
  ],
  via: { try: 'Run here', portal: 'Portal' },
  fresh: (n: number) => plural(n, 'new request', 'new requests'),
  capped: {
    hour: 'The log is full for this hour: calls are not recorded until the next hour.',
    total: 'The log is full: calls are not recorded until older ones expire.',
  },
  state: {
    createSandbox: 'Create sandbox',
    makeKey: 'Make a key',
    noKey: 'Your sandbox has no key.',
    console: 'Run in console',
    copyCurl: 'Copy command',
    hidden: (n: number) =>
      `${plural(n, 'call', 'calls')} from the portal ${n === 1 ? 'is' : 'are'} hidden`,
    showHidden: 'Show them',
    noCalls: 'No requests yet',
  },
  inspector: {
    request: 'Request',
    response: 'Response',
    body: 'Body',
    noBody: 'No body',
    bodiesGone: 'Bodies are kept for 24 hours.',
    expires: 'Bodies expire',
    runAgain: 'Run again',
    loading: 'Loading',
    failed: 'This request did not load.',
    tabs: 'Request and response',
    key: 'Key',
  },
} as const;
