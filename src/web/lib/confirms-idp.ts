import type { ConfirmCopy } from './confirms.ts';

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

export function removeMemberConfirm(who: string): ConfirmCopy {
  return {
    title: `Remove ${who}?`,
    confirmLabel: 'Remove',
    description: 'They leave the group at the next sync.',
    typed: false,
  };
}

export function removeClaimConfirm(key: string): ConfirmCopy {
  return {
    title: `Remove ${key}?`,
    confirmLabel: 'Remove',
    description: 'Apps stop receiving it.',
    typed: false,
  };
}
