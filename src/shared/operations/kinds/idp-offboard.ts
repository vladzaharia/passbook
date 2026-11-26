import { defineOperationKind } from '../define.ts';

/** Offboard ends PassBook access in the request, then this operation takes the roles away in Polaris ID. */
export const idpOffboard = defineOperationKind({
  kind: 'idp.offboard',
  audience: 'platform',
  read: null,
  write: null,
  cancel: 'never',
  retry: true,
  stepUp: true,
  dedupe: (s) => `idp:offboard:${s.userId}`,
  stallMs: 5 * 60_000,
  title: 'Offboard user',
  doneTitle: 'User offboarded',
  failTitle: 'Could not finish the offboard',
  steps: [
    {
      key: 'revoke',
      label: 'Check PassBook access',
      active: 'Checking that PassBook access ended',
    },
    { key: 'sync', label: 'Remove Polaris ID roles', active: 'Removing the roles in Polaris ID' },
    { key: 'confirm', label: 'Confirm', active: 'Reading the roles back from Polaris ID' },
  ],
  errors: {
    IDP_OFFBOARD_INCOMPLETE: 'PassBook access did not end. Offboard the user again.',
    IDP_NOT_READY: 'Polaris ID is paused or not reachable. Retry in a few minutes.',
    IDP_UNAVAILABLE: 'Polaris ID is not reachable. Retry in a few minutes.',
    IDP_SYNC_BUSY: 'Another Polaris ID sync is still running. Retry in a few minutes.',
    IDP_APPLY_FAILED: 'Polaris ID did not accept the change. Retry.',
    IDP_NOT_APPLIED: 'Polaris ID did not remove a role. Retry.',
    OPERATION_LEASE_LOST: 'Another runner took this over. Retry.',
  },
});
