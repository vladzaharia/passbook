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

/** Pausing stops every Polaris ID change; only the owner lifts it, in Polaris ID. */
export function freezeIdpConfirm(): ConfirmCopy {
  return {
    title: 'Pause Polaris ID changes?',
    confirmLabel: 'Pause',
    description: 'PassBook stops adding and removing access. Only the Polaris ID owner can resume.',
    typed: false,
  };
}

/** The dry run records differences and sends no change. */
export function dryRunConfirm(left: number | null): ConfirmCopy {
  return {
    title: 'Run a dry run?',
    confirmLabel: 'Run',
    description:
      left === null
        ? 'Records differences and changes nothing.'
        : `Records differences and changes nothing. It reads every group once; ${left} group reads left today.`,
    typed: false,
  };
}

export function checkNowConfirm(live: boolean, left: number | null): ConfirmCopy {
  const reads = left === null ? '' : ` It reads every group once; ${left} group reads left today.`;
  return {
    title: 'Check Polaris ID now?',
    confirmLabel: 'Check now',
    description: `${
      live ? 'Compares groups and fixes what is safe.' : 'Compares groups and records differences.'
    }${reads}`,
    typed: false,
  };
}

/** The latch holds back session ends until a person looks at the feed. */
export function clearBreakerConfirm(): ConfirmCopy {
  return {
    title: 'Clear the SCIM breaker?',
    confirmLabel: 'Clear',
    description: 'The next minute ends the sessions it held back. Check the feed first.',
    typed: false,
  };
}

/** A custom group goes from Polaris ID too; other apps lose it. */
export function deleteGroupConfirm(name: string): ConfirmCopy {
  return {
    title: `Delete ${name}?`,
    confirmLabel: 'Delete',
    description: 'Removes the group from Polaris ID. This cannot be undone.',
    typed: true,
  };
}

export function endRuleConfirm(org: string): ConfirmCopy {
  return {
    title: `End the rule for ${org}?`,
    confirmLabel: 'End rule',
    description: 'Its members leave the group at the next sync.',
    typed: false,
  };
}
