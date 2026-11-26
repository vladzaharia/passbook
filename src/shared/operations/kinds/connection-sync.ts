import { defineOperationKind } from '../define.ts';

export const connectionSync = defineOperationKind({
  kind: 'connection.sync',
  audience: 'org',
  read: 'integrations:read',
  write: 'integrations:manage',
  cancel: 'never',
  retry: true,
  stepUp: false,
  stallMs: 30 * 60_000,
  title: 'Sync connection',
  doneTitle: 'Sync finished',
  failTitle: 'Could not finish the sync',
  errors: {
    CONNECTION_SYNC_FAILED: 'The sync did not finish. Check the connection, then retry.',
    CONNECTION_SYNC_STALE: 'The connection changed during the sync. Retry.',
    CONNECTION_SYNC_RUNNING: 'A sync is already running.',
    CONNECTION_DISABLED: 'The connection is off. Turn it on, then retry.',
    ORG_INACTIVE: 'The organization is not active.',
  },
  steps: [
    { key: 'start', label: 'Check the connection', active: 'Checking the connection' },
    { key: 'records', label: 'Read records', active: 'Reading records', counts: true },
    { key: 'save', label: 'Save the result', active: 'Saving the result' },
  ],
});
