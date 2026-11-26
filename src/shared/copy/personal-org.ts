/** The word for an org that belongs to its one member, and its slug namespace. */
export const PERSONAL_ORG_COPY = {
  label: 'Personal',
  slugPrefix: 'personal-',
  singleMember: 'A personal organization has one member, its owner.',
  platformRefused: 'A personal organization is managed by its owner, not by the platform.',
  suspendedByPlatform:
    'The platform suspended this organization. Ask another administrator to lift it.',
  holdByPlatform: 'The platform placed this hold. Ask another administrator to release it.',
  planFixed: 'A personal organization is on Unlimited and its plan cannot change.',
  auditLabel: 'Personal org',
  slugReserved: 'Slugs starting with "personal-" are reserved.',
} as const;

/** How platform views name a personal org they do not list: "Personal org of <owner>". */
export const personalOrgLabel = (owner: string | null) =>
  owner ? `${PERSONAL_ORG_COPY.auditLabel} of ${owner}` : PERSONAL_ORG_COPY.auditLabel;

/**
 * How platform views name an org no directory lists: a developer sandbox by its developer (deleted or
 * not), a closed org by its stored name.
 */
export const hiddenOrgLabel = (
  kind: string,
  deleted: boolean,
  name: string,
  owner: string | null,
) => {
  if (kind === 'developer') {
    const word = deleted ? 'Deleted sandbox' : 'Sandbox';
    return owner ? `${word} (${owner})` : word;
  }
  return name && name !== 'Closed organization' ? name : 'Deleted organization';
};
