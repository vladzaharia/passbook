/** One plain line per preset: what the key may do. */
export const PRESET_FACT: Record<string, string> = {
  issue: 'Create and update passes.',
  read: 'Read passes, templates, scans and connections.',
  webhooks: 'Manage webhooks.',
  support: 'Assign holders, send messages.',
  messages: 'Send messages and scheduled changes.',
  sync: 'Import and sync passes and holders.',
  integrations: 'Connections and webhooks.',
  templates: 'Edit templates.',
  release: 'Edit, approve and release templates.',
  audit: 'Read the audit log.',
  brand: 'Manage the brand kit.',
  'scanner-setup': 'Set up scanners and read scans.',
  till: 'Scan as a terminal.',
  full: 'Everything a key can hold, but credentials.',
};

/** Scope area, from the id before the colon. */
export const AREA_LABEL: Record<string, string> = {
  passes: 'Passes',
  holders: 'Holders',
  templates: 'Templates',
  messages: 'Messages',
  scans: 'Scans',
  connections: 'Connections',
  webhooks: 'Webhooks',
  brand: 'Brand',
  org: 'Organization',
  wallet: 'Wallet',
  scanning: 'Scanning',
  'scan-setup': 'Scanning',
  nfc: 'Scanning',
  'api-keys': 'API keys',
  audit: 'Audit',
};
