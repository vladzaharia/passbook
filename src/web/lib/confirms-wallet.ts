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
