import type { ConfirmCopy } from './confirms.ts';

const CANNOT_UNDO = 'This cannot be undone.';

/** Revoking a wallet credential: its organizations turn Off, and an own account can be replaced. */
export function revokeWalletCredentialConfirm(name: string): ConfirmCopy {
  return {
    title: `Revoke ${name} credentials?`,
    confirmLabel: 'Revoke',
    description: `Organizations using them turn Off. ${CANNOT_UNDO}`,
    typed: false,
  };
}

export type MigrationAction = 'migrate' | 'assign_platform' | 'merge' | 'retire';

/** Moving legacy wallet accounts onto credential sources; `who` names the account. */
export function walletMigrationConfirm(
  action: MigrationAction,
  who: string,
  /** The organizations that claim the identity, for a merge. */
  claimants: readonly string[] = [],
): ConfirmCopy {
  const copy: Record<MigrationAction, Omit<ConfirmCopy, 'typed'>> = {
    migrate: {
      title: 'Run the migration?',
      confirmLabel: 'Run',
      description: 'Moves every account that can move. Refused accounts stay listed.',
    },
    assign_platform: {
      title: `Use PassBook's account for ${who}?`,
      confirmLabel: 'Assign',
      description: 'It signs with the PassBook credentials from now on.',
    },
    merge: {
      title: `Merge ${who} into a PassBook account?`,
      confirmLabel: 'Merge',
      description: `This identity becomes PassBook's credential. ${
        claimants.length > 0 ? `${claimants.join(', ')} and any` : 'Any'
      } other organization that claims it will sign with it.`,
    },
    retire: {
      title: `Retire ${who}?`,
      confirmLabel: 'Retire',
      description: `Revokes the legacy account. ${CANNOT_UNDO}`,
    },
  };
  return { ...copy[action], typed: false };
}

/** A wallet reissue: every active copy of the organization's passes is sent again. */
export function reissueWalletPassesConfirm(name: string): ConfirmCopy {
  return {
    title: `Update ${name} passes?`,
    confirmLabel: 'Update',
    description:
      'Sends every active copy again. Passes nobody has added to the wallet are skipped.',
    typed: false,
  };
}

/** A Samsung card id is permanent: it cannot be changed once it is set. */
export function setSamsungCardConfirm(type: string, cardId: string): ConfirmCopy {
  return {
    title: `Set the ${type} card to ${cardId}?`,
    confirmLabel: 'Set card',
    description: `The card for ${type} passes cannot be changed once it is set.`,
    typed: false,
  };
}

/** A platform hold turns an organization's wallet account Off until it is released. */
export function holdConfirm(name: string): ConfirmCopy {
  return {
    title: `Hold ${name}?`,
    confirmLabel: 'Hold',
    description: 'Turns it Off. The organization cannot turn it on until you release it.',
    typed: false,
  };
}

/** Enable-ready: every listed organization's Off account turns On, each under its own audit row. */
export function enableReadyConfirm(wallet: string, mode: string, count: number): ConfirmCopy {
  return {
    title: `Turn on ${count} ${count === 1 ? 'account' : 'accounts'}?`,
    confirmLabel: 'Turn on',
    description: `${wallet} ${mode} starts issuing for exactly the listed organizations.`,
    typed: false,
  };
}
