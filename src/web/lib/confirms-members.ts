import type { ConfirmCopy } from './confirms.ts';

/** Removing a member from the org; their roles go with them. */
export function removeMemberConfirm(name: string, org: string): ConfirmCopy {
  return {
    title: `Remove ${name}?`,
    confirmLabel: 'Remove',
    description: `They lose access to ${org} at once.`,
    typed: false,
  };
}
