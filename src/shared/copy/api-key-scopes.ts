/** Plain scope labels; the id stays beside them in mono. */
export const SCOPE_LABEL: Record<string, string> = {
  'passes:read': 'Read passes',
  'passes:write': 'Create and update passes',
  'holders:write': 'Assign holders',
  'templates:read': 'Read templates',
  'messages:write': 'Send messages and scheduled changes',
  'scans:read': 'Read scans and counts',
  'scans:write': 'Scan as a terminal',
  'connections:read': 'Read connections',
  'connections:write': 'Create and update connections',
  'webhooks:manage': 'Manage webhooks',
  'brand:manage': 'Manage brand kit',
  'scanning:write': 'Set up scanning',
  'scan-setup:read': 'Read scanner setups',
  'scanning:admin': 'Set up scanning with staff and devices',
  'api-keys:write': 'Manage its own child keys',
};
