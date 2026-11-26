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

/** Ending a developer's access; their other memberships stay. */
export function removeDeveloperConfirm(name: string): ConfirmCopy {
  return {
    title: `Remove ${name}?`,
    confirmLabel: 'Remove',
    description: 'Their developer access ends.',
    typed: false,
  };
}
