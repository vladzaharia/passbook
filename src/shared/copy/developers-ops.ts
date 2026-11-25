const plural = (n: number, one: string, many: string) =>
  `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ${n === 1 ? one : many}`;

/** Words on the developer portal's request log, "Your API" strip and public status page. Terse. */
export const LOGS_COPY = {
  nav: 'Logs',
  title: 'Request log',
  lede: 'Your sandbox’s API calls: metadata for 7 days, redacted bodies for 24 hours.',
  signedOut: 'Sign in to see your requests.',
  signIn: 'Sign in',
  noSandbox: 'No sandbox yet',
  create: 'Create sandbox',
  closed: 'Your sandbox is closed',
  notLoaded: 'Your requests did not load',
  failed: 'Could not load the log. Reload to try again.',
  retention: 'Sandbox calls only. Kept 7 days; bodies 24 hours, redacted.',
  live: {
    on: 'Listening',
    paused: 'Paused',
    resume: 'Resume',
    fresh: (n: number) => plural(n, 'new request', 'new requests'),
  },
  empty: {
    title: 'Waiting for your first call',
    noKeyTitle: 'No requests yet',
    noKey: 'Your sandbox has no key.',
    makeKey: 'Make a key',
    console: 'Run in console',
    portal: 'Show portal calls',
    copy: 'Copy command',
    noMatch: 'No requests match',
    clear: 'Clear filters',
  },
  count: (n: number) => plural(n, 'request', 'requests'),
  more: 'Load more',
  filters: {
    search: 'Search paths',
    status: 'Status',
    method: 'Method',
    code: 'Code',
    source: 'Source',
    any: 'Any',
    clear: 'Clear',
  },
  statusOptions: [
    { value: '2xx', label: '2xx' },
    { value: '4xx', label: '4xx' },
    { value: '5xx', label: '5xx' },
  ],
  /** Yours: your key's calls (terminal, SDK). Portal: Run here and the portal's own reads. */
  sources: [
    { value: 'key', label: 'Yours' },
    { value: 'try', label: 'Portal' },
    { value: 'all', label: 'All' },
  ],
  detail: {
    request: 'Request',
    response: 'Response',
    noBody: 'No body',
    bodiesGone: 'Bodies are kept for 24 hours.',
    expires: 'Bodies expire',
    key: 'Key',
    via: 'Run here',
    portal: 'Portal',
    curl: 'Copy as curl',
    console: 'Open in console',
    copyId: 'Copy request id',
    loading: 'Loading',
  },
  capped: {
    hour: 'The log is full for this hour: calls are not recorded until the next hour.',
    total: 'The log is full: calls are not recorded until older ones expire.',
  },
} as const;

export const RAIL_COPY = {
  title: 'Your API',
  noSandbox: 'No sandbox yet.',
  key: 'Key',
  test: 'Test',
  live: 'Live',
  tier: 'Rate tier',
  scopesLabel: 'Scopes',
  perMinute: 'a minute',
  tiers: { standard: 'Standard', high: 'High', bulk: 'Bulk' },
  scopes: (n: number) => plural(n, 'scope', 'scopes'),
  calls: 'Last hour',
  callsLabel: (n: number) => `${plural(n, 'call', 'calls')} in the last hour`,
  failed: 'Could not load.',
} as const;

export const STATUS_COPY = {
  title: 'Status',
  lede: 'Health of the PassBook platform and its channels.',
  overall: {
    operational: 'All systems operational',
    degraded: 'Some systems are degraded',
    outage: 'Service disruption',
  },
  state: {
    operational: 'Operational',
    degraded: 'Degraded',
    outage: 'Outage',
    off: 'Not enabled',
  },
  incidents: 'Incidents',
  noIncidents: 'No incidents in the last 14 days.',
  open: 'Open',
  resolved: 'Resolved',
  checked: 'Checked',
  impact: { notice: 'Notice', degraded: 'Degraded', outage: 'Outage' },
  unavailable: 'Status is unavailable. Try again in a minute.',
} as const;
