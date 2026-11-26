import type { ConfirmCopy } from './confirms.ts';

const ROLE: Record<string, string> = {
  console: 'Console',
  developer: 'Developer',
  support: 'Support',
};
const roleName = (role: string) => ROLE[role] ?? role;

/** Revoking a platform grant; the sync takes the role away in Polaris ID. */
export function revokeRoleConfirm(role: string, person: string): ConfirmCopy {
  return {
    title: `Revoke ${roleName(role)} access?`,
    confirmLabel: 'Revoke',
    description: `${person} loses ${roleName(role).toLowerCase()} access to PassBook.`,
    typed: false,
  };
}

/** A role someone added in Polaris ID. PassBook takes it away only on this word. */
export function removeExternalConfirm(role: string, person: string): ConfirmCopy {
  return {
    title: `Remove ${roleName(role)} access?`,
    confirmLabel: 'Remove',
    description: `${person} was given it in Polaris ID, not PassBook. It is removed there now.`,
    typed: false,
  };
}

/** Giving the role back after the Polaris ID owner paused it. */
export function restoreRoleConfirm(role: string, person: string): ConfirmCopy {
  return {
    title: `Restore ${roleName(role)} access?`,
    confirmLabel: 'Restore',
    description: `${person} gets ${roleName(role).toLowerCase()} access again, overriding the pause in Polaris ID.`,
    typed: false,
  };
}

export const removeGroupMemberConfirm = (group: string, person: string): ConfirmCopy => ({
  title: `Remove ${person}?`,
  confirmLabel: 'Remove',
  description: `They leave ${group} in Polaris ID.`,
  typed: false,
});

export const removeClaimConfirm = (key: string): ConfirmCopy => ({
  title: `Remove ${key}?`,
  confirmLabel: 'Remove',
  description: 'Every app that signs in with Polaris ID stops getting it.',
  typed: false,
});
