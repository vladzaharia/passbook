/** The Logs tool's page twin. The tool's own words are in developers-bench-logs.ts. */
export const LOGS_COPY = {
  title: 'Logs',
  lede: 'Your sandbox’s API calls: metadata for 7 days, redacted bodies for 24 hours.',
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
