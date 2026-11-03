/**
 * Words and guard for destructive confirms, so every dialog for the same act reads the same.
 * Spread into ConfirmDialog, or TypedConfirmDialog when `typed`.
 *
 * Blast radius decides typing. Type the name when the act cannot be undone and takes more than
 * the item with it: other records (an organization's templates, passes and connections; a
 * connection's synced passes) or what other people hold (a pass voids on its holders' devices).
 * An act that removes only the item itself takes a plain confirm, an API key included: revoking
 * a leaked key must stay one click away.
 */
export interface ConfirmCopy {
  title: string;
  confirmLabel: string;
  /** What happens, one sentence; "This cannot be undone." follows when it cannot. */
  description: string;
  typed: boolean;
}

const CANNOT_UNDO = 'This cannot be undone.';

export type DeletableEntity = 'org' | 'pass' | 'connection' | 'template' | 'identity';

const DELETE: Record<DeletableEntity, { consequence: string; typed: boolean }> = {
  org: { consequence: 'Its templates, passes and connections stop working.', typed: true },
  pass: {
    consequence: 'Voids it on every device, then removes it with its versions and images.',
    typed: true,
  },
  connection: { consequence: 'Bound passes keep their data and stop syncing.', typed: true },
  template: { consequence: 'Deletes the template and its versions.', typed: false },
  identity: {
    consequence: 'Templates and orgs using this identity fall back to the default.',
    typed: false,
  },
};

/** "Delete Northwind?" with the entity's consequence. */
export function deleteConfirm(entity: DeletableEntity, name: string): ConfirmCopy {
  const { consequence, typed } = DELETE[entity];
  return {
    title: `Delete ${name}?`,
    confirmLabel: 'Delete',
    description: `${consequence} ${CANNOT_UNDO}`,
    typed,
  };
}

/** Removing an address from an account: `self` on the holder's own Account page. */
export function removeEmailConfirm(email: string, self: boolean): ConfirmCopy {
  return {
    title: `Remove ${email}?`,
    confirmLabel: 'Remove',
    description: self
      ? 'You can no longer sign in with it, and passes sent to it leave your list.'
      : 'They can no longer sign in with it, and passes sent to it leave their list.',
    typed: false,
  };
}

/** Revoking an API key: requests with it fail at once. */
export function revokeKeyConfirm(name: string): ConfirmCopy {
  return {
    title: `Revoke ${name}?`,
    confirmLabel: 'Revoke',
    description: `Requests using this key fail at once. ${CANNOT_UNDO}`,
    typed: false,
  };
}
