/** The word for an org that belongs to its one member, and its slug namespace. */
export const PERSONAL_ORG_COPY = {
  label: 'Personal',
  slugPrefix: 'personal-',
  singleMember: 'A personal organization has one member, its owner.',
  platformRefused: 'A personal organization is managed by its owner, not by the platform.',
  suspendedByPlatform:
    'The platform suspended this organization. Ask another administrator to lift it.',
  planFixed: 'A personal organization is on Unlimited and its plan cannot change.',
  auditLabel: 'Personal org',
  slugReserved: 'Slugs starting with "personal-" are reserved.',
} as const;

/** How platform views name a personal org they do not list: "Personal org of <owner>". */
export const personalOrgLabel = (owner: string | null) =>
  owner ? `${PERSONAL_ORG_COPY.auditLabel} of ${owner}` : PERSONAL_ORG_COPY.auditLabel;
