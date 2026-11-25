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
import { CHANNEL_COPY } from '@/shared/copy/channels.ts';
import { PRINT_COPY } from '@/shared/copy/print.ts';

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

export type DeletableEntity =
  | 'org'
  | 'pass'
  | 'connection'
  | 'template'
  | 'identity'
  | 'webhook'
  | 'rule';

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
  webhook: { consequence: 'Pending deliveries are dropped.', typed: false },
  rule: { consequence: 'Messages that have not started are cancelled.', typed: false },
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

/** A holder who lost a phone: the pass is replaced and mailed to the email it was sent to. */
export function lostPhoneConfirm(passTitle: string): ConfirmCopy {
  return {
    title: 'Replace this pass?',
    confirmLabel: 'Replace pass',
    description: `${passTitle} gets a new code and link, and we email it to you. Copies on your old phone stop working at the door.`,
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

/** Replacing the keys of tags already on a keyset: taps from tags still written with the old keys fail. */
export function rekeyTagsConfirm(count: number): ConfirmCopy {
  return {
    title: `Re-key ${count} ${count === 1 ? 'tag' : 'tags'}?`,
    confirmLabel: 'Re-key',
    description: `Taps with the old keys stop working. Rewrite each tag with its new key.`,
    typed: false,
  };
}

/** A new scan code: a copy of the old barcode stops working at every scanner. */
export function newCodeConfirm(): ConfirmCopy {
  return {
    title: 'Make a new code?',
    confirmLabel: 'New code',
    description: 'The old code stops working at every scanner. The holder gets the pass again.',
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

/** Archiving a zone takes the zones inside it too; restoring brings them back. */
export function archiveZoneConfirm(
  name: string,
  use: { sessions: number; plans: number; below: number },
): ConfirmCopy {
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const s = (n: number) => (n === 1 ? 's' : '');
  const inside = use.below ? ` ${count(use.below, 'zone')} inside it archive too.` : '';
  return {
    title: `Archive ${name}?`,
    confirmLabel: 'Archive',
    description: `Doors stop letting anyone in. ${count(use.sessions, 'session')} check${s(use.sessions)} it; ${count(use.plans, 'plan')} grant${s(use.plans)} it.${inside} You can restore it.`,
    typed: false,
  };
}

/** Counting someone out by hand; the pass keeps working. */
export function markOutConfirm(holder: string, place: string): ConfirmCopy {
  return {
    title: `Mark ${holder} as out?`,
    confirmLabel: 'Mark as out',
    description: `They leave ${place}. Their pass keeps working.`,
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

/** A holder reporting their tag lost: it stops opening doors, and only the org restores it. */
export function reportTagLostConfirm(name: string, org: string, allPasses: boolean): ConfirmCopy {
  return {
    title: `Report ${name} lost?`,
    confirmLabel: 'Report lost',
    description: `It stops opening doors${allPasses ? ' on all your passes' : ''} now. Ask ${org} to restore it or replace it.`,
    typed: false,
  };
}

/** A reprint replaces the earlier print: its code stops working at every scanner. */
export function reprintConfirm(): ConfirmCopy {
  return {
    title: PRINT_COPY.reprintConfirmTitle,
    confirmLabel: PRINT_COPY.reprint,
    description: PRINT_COPY.reprintConfirmBody,
    typed: false,
  };
}

/** Voiding a print ends its code; printing again makes a new one. */
export function voidPrintConfirm(): ConfirmCopy {
  return {
    title: PRINT_COPY.voidConfirmTitle,
    confirmLabel: PRINT_COPY.void,
    description: PRINT_COPY.voidConfirmBody,
    typed: false,
  };
}

/** One pass's channel off: no new copies, and the ones out there keep working until New code. */
export function channelOffConfirm(channel: string, paper = false): ConfirmCopy {
  return {
    title: CHANNEL_COPY.turnOffTitle.replace('{channel}', channel),
    confirmLabel: 'Turn off',
    description: paper ? CHANNEL_COPY.turnOffPassPaper : CHANNEL_COPY.turnOffPass,
    typed: false,
  };
}

/** Bulk Off: no new copies for the selected passes; the ones out there keep working until New code. */
export function bulkChannelsOffConfirm(channels: readonly string[], count: number): ConfirmCopy {
  const last = channels.at(-1) ?? '';
  const names = channels.length > 1 ? `${channels.slice(0, -1).join(', ')} and ${last}` : last;
  return {
    title: `Turn off ${names} for ${count} ${count === 1 ? 'pass' : 'passes'}?`,
    confirmLabel: 'Turn off',
    description: CHANNEL_COPY.copiesKeep,
    typed: false,
  };
}
