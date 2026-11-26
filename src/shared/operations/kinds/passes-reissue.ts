import { defineOperationKind } from '../define.ts';

export const passesReissue = defineOperationKind({
  kind: 'passes.reissue',
  audience: 'org',
  read: 'passes:read',
  write: 'passes:operate',
  cancel: 'never',
  retry: true,
  stepUp: false,
  stallMs: 20 * 60_000,
  title: 'Rebuild passes',
  doneTitle: 'Passes rebuilt',
  failTitle: 'Could not rebuild passes',
  errors: {
    BULK_REISSUE_FAILED: 'The rebuild stopped part way. Retry.',
    REISSUE_PRINCIPAL_REVOKED: 'Your access ended. Sign in, then retry.',
    WORKFLOW_START: 'The rebuild did not start. Retry.',
    BULK_RUN_ACTIVE: 'A rebuild of this target is already running.',
    TEMPLATE_RELEASE_CONFLICT: 'The approved release changed. Retry.',
  },
  steps: [
    { key: 'start', label: 'Start the run', active: 'Starting the run' },
    { key: 'passes', label: 'Rebuild passes', active: 'Rebuilding passes', counts: true },
    { key: 'finish', label: 'Save the result', active: 'Saving the result' },
  ],
});
