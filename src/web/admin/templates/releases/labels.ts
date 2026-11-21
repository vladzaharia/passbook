const ROLE = {
  'templates:author': 'an author',
  'templates:review': 'a reviewer',
  'templates:publish': 'a publisher',
} as const;

/** "Ask a publisher" style wording for a capability key. */
export const roleLabel = (key: keyof typeof ROLE) => ROLE[key];

export const PROVIDER = { apple: 'Apple', google: 'Google', samsung: 'Samsung' } as const;
