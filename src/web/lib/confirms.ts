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
  /** Replaces the dialog's "Cancel" where that would read as the confirm's own word. */
  cancelLabel?: string;
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

/** Voiding passes: holders see them as void at once, and Unvoid brings them back. */
export function voidConfirm(count = 1): ConfirmCopy {
  const one = count === 1;
  return {
    title: one ? 'Void pass?' : `Void ${count} passes?`,
    confirmLabel: 'Void',
    description: one
      ? "Wallet shows it as void on the holder's device. You can unvoid it later."
      : "Wallet shows them as void on every holder's device. You can unvoid them later.",
    typed: false,
  };
}

/** Taking a pass from its holder; `owner` names who loses it from their account. */
export function clearHolderConfirm(owner: string | null): ConfirmCopy {
  return {
    title: 'Clear holder?',
    confirmLabel: 'Clear holder',
    description: owner
      ? `${owner} loses the pass in their account.`
      : 'The pass goes back to having no holder.',
    typed: false,
  };
}

/** Archiving a template: new passes cannot use it; the ones it has keep working. */
export function archiveConfirm(name: string, passCount: number): ConfirmCopy {
  const kept =
    passCount === 0
      ? ''
      : passCount === 1
        ? ' 1 existing pass keeps working.'
        : ` ${passCount} existing passes keep working.`;
  return {
    title: `Archive ${name}?`,
    confirmLabel: 'Archive',
    description: `New passes cannot use it.${kept}`,
    typed: false,
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

/** An admin ending someone else's sessions; they sign in again. Your own: Account's Sign out everywhere. */
export function revokeSessionsConfirm(name: string): ConfirmCopy {
  return {
    title: `Sign ${name} out everywhere?`,
    confirmLabel: 'Revoke all',
    description: 'Every session ends. They can sign in again.',
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

/** Revoking a member's access or a pending invitation; `self` is your own membership. */
export function revokeAccessConfirm(
  kind: 'memberships' | 'invitations',
  label: string,
  { self, org }: { self: boolean; org: string },
): ConfirmCopy {
  if (kind === 'invitations') {
    return {
      title: `Revoke the invitation for ${label}?`,
      confirmLabel: 'Revoke',
      description: 'The link stops working at once.',
      typed: false,
    };
  }
  return {
    title: self ? `Remove your access to ${org}?` : `Revoke ${label}?`,
    confirmLabel: self ? 'Remove my access' : 'Revoke',
    description: self
      ? `You lose access to ${org} at once.`
      : `They lose access to ${org} at once.`,
    typed: false,
  };
}

/** Revoking a scanner: plain, so a lost phone stays one click away (like an API key). */
export function revokeScannerConfirm(name: string): ConfirmCopy {
  return {
    title: `Revoke ${name}?`,
    confirmLabel: 'Revoke',
    description: `The device stops scanning at once. Its scans stay. ${CANNOT_UNDO}`,
    typed: false,
  };
}

/** Pairing a paired scanner again: reversible, so not a danger button. */
export function pairAgainConfirm(name: string): ConfirmCopy {
  return {
    title: `Pair ${name} again?`,
    confirmLabel: 'Pair again',
    description: 'The device using it now signs out at its next scan.',
    typed: false,
  };
}

/** A Test scanner turning live; the device keeps its pairing. */
export function goLiveConfirm(name: string): ConfirmCopy {
  return {
    title: `Make ${name} live?`,
    confirmLabel: 'Go live',
    description:
      'It starts accepting live passes and stops accepting test ones. Its test scans stay in Test mode.',
    typed: false,
  };
}

/** Cancelling what has not started. A draft is not deleted: the server moves it to Cancelled, same as a scheduled one. */
export function cancelBroadcastConfirm(
  name: string,
  kind: 'message' | 'change',
  state: string,
): ConfirmCopy {
  const noun = kind === 'change' ? 'change' : 'message';
  return {
    title: `Cancel ${name}?`,
    confirmLabel: `Cancel ${noun}`,
    description:
      state === 'draft'
        ? 'It moves to Cancelled. No pass changes.'
        : kind === 'change'
          ? 'No pass changes. You can schedule a new change later.'
          : 'No pass changes. You can send a new one later.',
    typed: false,
    cancelLabel: 'Keep it',
  };
}

/** An uncertain webhook event: the operator vouches the source system was checked. */
export function resolveWebhookConfirm(event: string): ConfirmCopy {
  return {
    title: `Mark ${event} resolved?`,
    confirmLabel: 'Mark resolved',
    description: 'Confirm you checked the source system. The event stops needing attention.',
    typed: false,
  };
}
