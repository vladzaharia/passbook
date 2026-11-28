export const LABEL_API = {
  api: 'API access',
  'api.rateTier': 'API rate tier',
  'api.keys': 'API keys',
  apps: 'Apps',
  webhooks: 'Webhooks',
  'webhooks.endpoints': 'Webhook endpoints',
} as const;

export const LEVEL_LABEL_API = {
  api: { off: 'Off', read: 'Read only', full: 'Full' },
  'api.rateTier': { standard: 'Standard', high: 'High', bulk: 'Bulk' },
} as const;
