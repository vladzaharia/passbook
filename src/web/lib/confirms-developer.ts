import type { ConfirmCopy } from './confirms.ts';

/** A developer sandbox reset: test data goes and the key changes; the sandbox, ticket template and quickstart stay. */
export const resetSandboxConfirm: ConfirmCopy = {
  title: 'Reset this sandbox?',
  confirmLabel: 'Reset sandbox',
  description:
    'Passes, events and logs in this sandbox are deleted. Your key changes. 3 resets a day.',
  typed: false,
};
