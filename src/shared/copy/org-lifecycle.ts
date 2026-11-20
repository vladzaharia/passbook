/** Words of the org close notice and the lifecycle console. */
export const ORG_LIFECYCLE_COPY = {
  closedSubject: (org: string) => `${org} is closed`,
  closedBody: (org: string, purgeDate: string) =>
    `${org} is closed. Its passes stop updating and the organization is read-only. Download your data before ${purgeDate}, when everything is removed. Ask PassBook to reopen it before then.`,
  reopenedSubject: (org: string) => `${org} is open again`,
  reopenedBody: (org: string) => `${org} is open again. Its passes update as before.`,
  slugMismatch: 'The slug does not match. Type it exactly.',
  held: 'A legal hold is active. Release it before closing the organization.',
  windowOver: 'The reopen window is over.',
  purging: 'The organization is being removed.',
} as const;
