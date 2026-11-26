import type { ConfirmCopy } from './confirms.ts';

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

/** What the page says while the call is out, until the server names the operation: its live steps then take the note's place. */
export const sandboxWorking = {
  delete: { title: 'Deleting your sandbox', detail: 'Passes, keys, webhooks and logs are going.' },
  'start-over': { title: 'Making a new sandbox', detail: 'The old one is deleted first.' },
} as const;
