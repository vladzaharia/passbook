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
export function walletMigrationConfirm(action: MigrationAction, who: string): ConfirmCopy {
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
      description:
        'The shared identity becomes a PassBook credential, and every account that claims it follows.',
    },
    retire: {
      title: `Retire ${who}?`,
      confirmLabel: 'Retire',
      description: `Revokes the legacy account. ${CANNOT_UNDO}`,
    },
  };
  return { ...copy[action], typed: false };
}
