/** Words of the identity move: the old pass's lock-screen message and the reminder email. */
export const IDENTITY_MOVE_COPY = {
  /** The change message on the old pass; Wallet fills `%@` with the field's value, the add link. */
  changeMessage: 'New pass ready: %@',
  reminderSubject: (org: string) => `Add your new ${org} pass`,
  reminderBody: (org: string, url: string) =>
    `Your new ${org} pass is ready, and your current pass will stop updating. Add the new pass: ${url}`,
} as const;
