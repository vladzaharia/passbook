import { defineOperationKind } from '../define.ts';

export const orgExport = defineOperationKind({
  kind: 'org.export',
  audience: 'org',
  read: 'org:manage',
  write: 'org:manage',
  cancel: 'never',
  retry: true,
  stepUp: true,
  stallMs: 15 * 60_000,
  title: 'Export data',
  doneTitle: 'Export ready',
  failTitle: 'Could not export',
  errors: {
    ORG_EXPORT_FAILED: 'The export did not finish. Retry.',
    ORG_EXPORT_START: 'The export did not start. Retry.',
    ORG_EXPORT_RUNNING: 'Another export is running. Wait for it to finish.',
    ORG_PURGING: 'This organization is being removed.',
  },
  steps: [
    { key: 'rows', label: 'Write records', active: 'Writing records', counts: true },
    { key: 'zip', label: 'Build archive', active: 'Building the archive' },
    { key: 'save', label: 'Save archive', active: 'Saving the archive' },
  ],
});
