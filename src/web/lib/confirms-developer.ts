import type { ConfirmCopy } from './confirms.ts';

/** A developer sandbox reset: test data goes and the key changes; the sandbox, ticket template and quickstart stay. */
export const resetSandboxConfirm: ConfirmCopy = {
  title: 'Reset this sandbox?',
  confirmLabel: 'Reset sandbox',
  description:
    'Passes, events and logs in this sandbox are deleted. Your key changes. 3 resets a day.',
  typed: false,
};

/** Start over: the sandbox is deleted and made again, new and empty. */
export const startOverSandboxConfirm: ConfirmCopy = {
  title: 'Start over?',
  confirmLabel: 'Start over',
  description:
    'This sandbox is deleted with its passes, keys, webhooks and logs, and a new one is made. 3 a day.',
  typed: false,
};

/** Delete: the sandbox is gone; a new one is one click away. */
export const deleteSandboxConfirm: ConfirmCopy = {
  title: 'Delete this sandbox?',
  confirmLabel: 'Delete sandbox',
  description:
    'Passes, keys, webhooks and logs are deleted. You can make a new sandbox after. 3 a day.',
  typed: false,
};
