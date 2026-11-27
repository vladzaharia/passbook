const plural = (n: number, one: string, many: string) =>
  `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ${n === 1 ? one : many}`;

/** Words on the Logs tool of the Workbench. Terse. */
export const LOGS_BENCH_COPY = {
  list: 'Requests',
  count: (n: number, more: boolean) => (more ? `${n}+ requests` : plural(n, 'request', 'requests')),
  views: { label: 'View', all: 'All', errors: 'Errors' },
  search: 'Search paths',
  toolbar: 'Filter requests',
  select: 'Select a request',
  filters: {
    status: 'Status',
    method: 'Method',
    code: 'Code',
    key: 'Key',
    pass: 'Pass',
    version: 'Version',
    source: 'Source',
    all: 'All',
    clearPass: (tail: string) => `Clear pass filter ${tail}`,
  },
  statusOptions: [
    { value: '2xx', label: '2xx' },
    { value: '4xx', label: '4xx' },
    { value: '5xx', label: '5xx' },
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  sources: [
    { value: 'key', label: 'Keys' },
    { value: 'try', label: 'Run here' },
  ],
  via: { try: 'Run here', portal: 'Portal' },
  fresh: (n: number) => plural(n, 'new request', 'new requests'),
  capped: {
    hour: 'The log is full for this hour: calls are not recorded until the next hour.',
    total: 'The log is full: calls are not recorded until older ones expire.',
  },
  state: {
    createSandbox: 'Create sandbox',
    makeKey: 'New key',
    noKey: 'No Test key yet.',
    console: 'Run in Console',
    copyCurl: 'Copy command',
    hidden: (n: number) =>
      `${plural(n, 'call', 'calls')} from the portal ${n === 1 ? 'is' : 'are'} hidden`,
    showHidden: 'Show them',
    noCalls: 'No requests yet',
    noErrors: 'No errors',
  },
  inspector: {
    request: 'Request',
    response: 'Response',
    headers: 'Headers',
    noHeaders: 'No headers recorded',
    body: 'Body',
    noBody: 'No body',
    bodiesGone: 'Body kept 24 h',
    truncated: 'Cut at 8 KB',
    expires: 'Bodies expire',
    openInConsole: 'Open in Console',
    loading: 'Loading',
    failed: 'This request did not load.',
    tabs: 'Request and response',
    key: 'Key',
  },
} as const;
