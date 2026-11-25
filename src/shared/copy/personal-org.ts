/** The word for an org that belongs to its one member, and its slug namespace. */
export const PERSONAL_ORG_COPY = {
  label: 'Personal',
  slugPrefix: 'personal-',
  singleMember: 'A personal organization has one member, its owner.',
  platformRefused: 'A personal organization is managed by its owner, not by the platform.',
  auditLabel: 'Personal org',
  slugReserved: 'Slugs starting with "personal-" are reserved.',
} as const;
