const ROLE = {
  'templates:author': 'an author',
  'templates:review': 'a reviewer',
  'templates:publish': 'a publisher',
} as const;

/** "Ask a publisher" style wording for a capability key. */
export const roleLabel = (key: keyof typeof ROLE) => ROLE[key];

export const SOURCE_LABEL = { approved: 'Approved', system: 'Built-in', legacy: 'Legacy' } as const;

export const ACTION_LABEL = {
  release: 'Published',
  rollback: 'Rolled back',
  system: 'Built-in',
  legacy: 'Legacy',
} as const;

const PROVIDER = { apple: 'Apple', google: 'Google', samsung: 'Samsung' } as const;

export const providerModeLabel = (provider: keyof typeof PROVIDER, mode: 'live' | 'test') =>
  `${PROVIDER[provider]} · ${mode === 'live' ? 'Live' : 'Test'}`;
