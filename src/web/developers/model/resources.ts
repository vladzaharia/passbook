/** Which page a resource lives on, in which group, under which name. Every published resource must be listed. */

/** The jobs the reference groups by, in nav order (design-portal-devex.md §2). */
export const GROUP_ORDER = [
  'Passes',
  'Templates',
  'Messages',
  'Scanning',
  'NFC',
  'Webhooks and events',
  'Connections',
  'Organization',
] as const;

const GROUPS: Record<string, (typeof GROUP_ORDER)[number]> = {
  passes: 'Passes',
  printJobs: 'Passes',
  passImports: 'Passes',
  bundles: 'Passes',
  holders: 'Passes',
  bulkRuns: 'Passes',
  passViews: 'Passes',
  templates: 'Templates',
  templateImports: 'Templates',
  blueprints: 'Templates',
  broadcasts: 'Messages',
  messageRules: 'Messages',
  deliveries: 'Messages',
  testEmails: 'Messages',
  terminal: 'Scanning',
  scans: 'Scanning',
  scanningSessions: 'Scanning',
  scanSetups: 'Scanning',
  scanEvents: 'Scanning',
  scanZones: 'Scanning',
  scanners: 'Scanning',
  scanStaff: 'Scanning',
  rollCalls: 'Scanning',
  nfc: 'NFC',
  webhookEndpoints: 'Webhooks and events',
  events: 'Webhooks and events',
  connections: 'Connections',
  connectors: 'Connections',
  orgs: 'Organization',
  brand: 'Organization',
  apiKeys: 'Organization',
  operations: 'Organization',
  auditEntries: 'Organization',
  developerInvitations: 'Organization',
  developers: 'Organization',
};

const LABELS: Record<string, string> = {
  auditEntries: 'Audit log',
  apiKeys: 'API keys',
  nfc: 'NFC',
  orgs: 'Organizations',
  terminal: 'Till API',
  testEmails: 'Test inbox',
  webhookEndpoints: 'Webhook endpoints',
};

const words = (key: string) =>
  key
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .trim();

export const slugOf = (key: string) => words(key).replaceAll(' ', '-');
export const labelOf = (key: string) =>
  LABELS[key] ?? words(key).replace(/^./, (c) => c.toUpperCase());

export function groupOf(key: string): string {
  const group = GROUPS[key];
  if (!group)
    throw new Error(`Reference resource "${key}" has no group: add it to GROUPS in resources.ts.`);
  return group;
}
