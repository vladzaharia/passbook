import { defineOperationKind, type OperationStepDef } from '../define.ts';

/** The four sandbox actions share one subject, so a person has one running at a time. */
const dedupe = (s: Record<string, string>) => `sandbox:${s.userId}`;
/** What each stop says: what happened and what to do, by error code. */
const errors = {
  SANDBOX_TEMPLATE_FAILED: 'The ticket template did not finish. Retry.',
  FEATURE_NOT_INCLUDED: 'Webhooks are off on this plan. Retry.',
  SANDBOX_CONFLICT: 'The sandbox changed. Retry.',
  SANDBOX_SESSION_ENDED: 'Your sign-in ended. Sign in, then start again.',
  SANDBOX_PURGE_START: 'The cleanup did not start. Retry.',
  SANDBOX_RESET_LIMIT: 'You have used the resets for today. Try tomorrow.',
  ORG_HELD: 'A legal hold stands on this sandbox.',
  ORG_PURGE_BLOCKED: 'Some passes could not be removed yet. Retry.',
} as const;

const common = {
  tokenActs: true,
  errors,
  audience: 'starter',
  read: null,
  write: null,
  cancel: 'never',
  retry: true,
  stallMs: 10 * 60_000,
  dedupe,
} as const;

const make = (): OperationStepDef[] => [
  { key: 'org', label: 'Create sandbox', active: 'Creating your sandbox' },
  { key: 'template', label: 'Add ticket template', active: 'Adding the ticket template' },
  { key: 'release', label: 'Release it in Test', active: 'Releasing the ticket in Test' },
  { key: 'capture', label: 'Add capture endpoint', active: 'Adding the capture endpoint' },
  { key: 'scanner', label: 'Add test scanner', active: 'Adding a test scanner' },
];

const remove = (): OperationStepDef[] => [
  { key: 'close', label: 'Close sandbox', active: 'Closing your sandbox' },
  { key: 'keys', label: 'Revoke keys', active: 'Revoking keys', counts: true },
  { key: 'passes', label: 'Remove Test passes', active: 'Removing Test passes', counts: true },
  // Waits after Done: the org purge erases the data once devices have had their days.
  { key: 'erase', label: 'Erase sandbox data', tail: true },
];

const grouped = (steps: OperationStepDef[], group: string): OperationStepDef[] =>
  steps.map((s) => ({ ...s, group }));

export const sandboxCreate = defineOperationKind({
  ...common,
  kind: 'sandbox.create',
  stepUp: false,
  title: 'Create sandbox',
  doneTitle: 'Sandbox ready',
  failTitle: 'Could not finish your sandbox',
  steps: make(),
});

export const sandboxDelete = defineOperationKind({
  ...common,
  kind: 'sandbox.delete',
  stepUp: true,
  title: 'Delete sandbox',
  doneTitle: 'Sandbox deleted',
  failTitle: 'Could not delete sandbox',
  steps: remove(),
});

export const sandboxReset = defineOperationKind({
  ...common,
  kind: 'sandbox.reset',
  stepUp: true,
  title: 'Reset sandbox',
  doneTitle: 'Sandbox reset',
  failTitle: 'Could not reset sandbox',
  steps: [
    { key: 'claim', label: 'Revoke old key', active: 'Revoking the old key' },
    {
      key: 'passes',
      label: 'Delete Test passes',
      active: 'Deleting Test passes',
      counts: true,
    },
    {
      key: 'captures',
      label: 'Delete captured events',
      active: 'Deleting captured events',
      counts: true,
    },
    {
      key: 'rows',
      label: 'Clear calls and drafts',
      active: 'Clearing calls, messages and imports',
      counts: true,
    },
    { key: 'template', label: 'Release the ticket again', active: 'Releasing the ticket in Test' },
  ],
});

export const sandboxRecreate = defineOperationKind({
  ...common,
  kind: 'sandbox.recreate',
  stepUp: true,
  title: 'Start over',
  doneTitle: 'New sandbox ready',
  failTitle: 'Could not start over',
  steps: [...grouped(remove(), 'Old sandbox'), ...grouped(make(), 'New sandbox')],
});
