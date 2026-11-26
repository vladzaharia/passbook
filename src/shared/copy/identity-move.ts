/** Words of the identity move: the old pass's lock-screen message and the reminder email. */
export const IDENTITY_MOVE_COPY = {
  /** The change message on the old pass; Wallet fills `%@` with the field's value, the add link. */
  changeMessage: 'New pass ready: %@',
  reminderSubject: 'Add your new pass',
  /** `org` is null when the organization cannot be read: the sentence then names none. */
  reminderBody: (org: string | null, url: string) =>
    `Your new ${org ? `${org} ` : ''}pass is ready. Add it: ${url}`,
} as const;
