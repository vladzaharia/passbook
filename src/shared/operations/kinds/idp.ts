import { defineOperationKind, type OperationStepDef } from '../define.ts';

/** What each stop says: what happened and what to do, by error code. */
const errors = {
  IDP_NOT_READY: 'Polaris ID is paused or not reachable. Retry in a few minutes.',
  IDP_UNAVAILABLE: 'Polaris ID is not reachable. Retry in a few minutes.',
  IDP_SYNC_BUSY: 'Another Polaris ID sync is still running. Retry in a few minutes.',
  IDP_NOT_HELD: 'This role is not paused any more.',
  IDP_HOLD_NOT_FOUND: 'This role is not paused.',
  IDP_NOT_APPLIED: 'Polaris ID did not add the role. Retry.',
  IDP_APPLY_FAILED: 'Polaris ID did not accept the change. Retry.',
  IDP_BREAKER_RETRIPPED: 'The breaker tripped again. Check the feed, then clear it again.',
  IDP_NOT_WANTED: 'No reason wants this role now, or the user is off. Nothing was restored.',
  IDP_BUDGET_LOW: 'Too few Polaris ID reads left today. The daily check keeps them. Try tomorrow.',
  IDP_ADMIN_ENDED: 'The admin who started this is no longer a signed-in platform admin.',
  OPERATION_LEASE_LOST: 'Another runner took this over. Retry.',
} as const;

/** Platform admins only; a stop or retry needs a recent Polaris ID sign-in. */
const common = {
  errors,
  audience: 'platform',
  read: null,
  write: null,
  retry: true,
  stepUp: true,
  stallMs: 5 * 60_000,
} as const;

const compare = (): OperationStepDef[] => [
  { key: 'connect', label: 'Check Polaris ID', active: 'Checking that Polaris ID is ready' },
  { key: 'compare', label: 'Compare groups', active: 'Comparing Polaris ID groups with PassBook' },
];

/** Check now and the dry run share one subject: one sync run at a time. */
const syncSubject = () => 'idp:sync';

export const idpCheck = defineOperationKind({
  ...common,
  kind: 'idp.check',
  cancel: 'never',
  dedupe: syncSubject,
  title: 'Check Polaris ID',
  doneTitle: 'Polaris ID checked',
  failTitle: 'Could not check Polaris ID',
  steps: compare(),
});

export const idpDryRun = defineOperationKind({
  ...common,
  kind: 'idp.dry_run',
  cancel: 'never',
  dedupe: syncSubject,
  title: 'Dry run',
  doneTitle: 'Dry run done',
  failTitle: 'Could not finish the dry run',
  steps: compare(),
});

export const idpRestore = defineOperationKind({
  ...common,
  kind: 'idp.restore',
  cancel: 'never',
  dedupe: (s) => `idp:restore:${s.userId}:${s.role}`,
  title: 'Restore role',
  doneTitle: 'Role restored',
  failTitle: 'Could not restore the role',
  steps: [
    { key: 'release', label: 'Clear the pause', active: 'Clearing the pause' },
    { key: 'apply', label: 'Add it in Polaris ID', active: 'Adding the role in Polaris ID' },
    { key: 'confirm', label: 'Confirm', active: 'Reading it back from Polaris ID' },
  ],
});

export const idpBreakerClear = defineOperationKind({
  ...common,
  kind: 'idp.breaker_clear',
  cancel: 'never',
  dedupe: () => 'idp:breaker',
  title: 'Clear the SCIM breaker',
  doneTitle: 'SCIM breaker cleared',
  failTitle: 'Could not clear the SCIM breaker',
  steps: [
    { key: 'clear', label: 'Clear the latch', active: 'Clearing the latch' },
    { key: 'confirm', label: 'Confirm', active: 'Checking the latch is gone' },
  ],
});
