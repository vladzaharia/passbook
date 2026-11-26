import { defineOperationKind } from '../define.ts';

export const channelCodes = defineOperationKind({
  kind: 'channels.replace_codes',
  audience: 'org',
  read: 'passes:read',
  write: 'passes:operate',
  cancel: 'never',
  // A run's passes are not kept on the operation, so the person runs the action again from the list.
  retry: false,
  stepUp: false,
  stallMs: 30 * 60_000,
  title: 'Replace codes',
  doneTitle: 'Codes replaced',
  failTitle: 'Could not replace every code',
  errors: {
    OPERATION_STALLED: 'The replacement stopped. Select the passes and replace codes again.',
  },
  steps: [
    { key: 'channels', label: 'Update channels', active: 'Updating channels', counts: true },
    { key: 'codes', label: 'Replace codes', active: 'Replacing codes', counts: true },
  ],
});
