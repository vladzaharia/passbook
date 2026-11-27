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
  IDP_FROZEN: 'Polaris ID changes are paused. Ask the PassBook owner.',
  IDP_CLIENT: "PassBook's Polaris ID app needs a change first. Check setup.",
  IDP_SCIM_FOREIGN: 'Polaris ID sends users somewhere other than PassBook. Ask the PassBook owner.',
  IDP_SCIM_MISSING: 'Polaris ID has no user sync for PassBook yet. Run setup first.',
  IDP_SETUP_BINDING_ABSENT: 'The Polaris ID connector is not deployed. Ask the PassBook owner.',
  IDP_SETUP_AUTH: "Polaris ID refused PassBook's key. Ask the PassBook owner to replace it.",
  IDP_SETUP_LAYOUT: 'The Polaris ID layout looks wrong. Ask the PassBook owner to check it.',
  IDP_SETUP_SETTINGS: 'Polaris ID settings need a change. Ask the PassBook owner.',
  IDP_SETUP_CLIENT_MISSING: 'Sign in to PassBook with Polaris ID once, then run setup again.',
  IDP_SETUP_CLIENT_WRONG:
    "PassBook's app in Polaris ID is not set up as expected. Ask the PassBook owner.",
  IDP_SETUP_GROUP_IN_USE: 'A role group is used by another app. Ask the PassBook owner.',
  IDP_SETUP_GROUP_MISSING: 'A required Polaris ID group is missing. Ask the PassBook owner.',
  IDP_SETUP_SCIM_PUSH: 'Polaris ID has not pushed users yet. Check the connection, then retry.',
  IDP_SETUP_MIRROR_EMPTY: 'Polaris ID pushed no users or groups. Check the connection, then retry.',
  IDP_SETUP_TOKEN: 'Polaris ID did not take the new SCIM token. Retry.',
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

/** One setup at a time; a rotation shares the subject, as both write the SCIM token. */
const setupSubject = () => 'idp:setup';

export const idpSetup = defineOperationKind({
  ...common,
  kind: 'idp.setup',
  cancel: 'between-steps',
  dedupe: setupSubject,
  title: 'Set up Polaris ID',
  doneTitle: 'Polaris ID set up',
  failTitle: 'Could not set up Polaris ID',
  steps: [
    { key: 'check', label: 'Check Polaris ID', active: 'Reading the Polaris ID setup' },
    { key: 'groups', label: 'Groups', active: 'Placing the role groups' },
    { key: 'client_groups', label: 'Allowed groups', active: 'Allowing the groups on the app' },
    { key: 'client_restricted', label: 'Only these groups', active: 'Restricting the app' },
    { key: 'client_logo', label: 'App logo', active: 'Setting the app logo' },
    { key: 'scim_token', label: 'SCIM token', active: 'Creating the SCIM token' },
    { key: 'scim_provider', label: 'SCIM connection', active: 'Adding the SCIM connection' },
    { key: 'scim_sync', label: 'First sync', active: 'Waiting for the first sync' },
    { key: 'scim_mirror', label: 'Directory copy', active: 'Waiting for users and groups' },
  ],
});

export const idpScimRotate = defineOperationKind({
  ...common,
  kind: 'idp.scim_rotate',
  cancel: 'never',
  dedupe: setupSubject,
  title: 'Rotate SCIM token',
  doneTitle: 'SCIM token rotated',
  failTitle: 'Could not rotate the SCIM token',
  steps: [
    { key: 'token', label: 'New token', active: 'Giving Polaris ID the new token' },
    { key: 'switch', label: 'Switch', active: 'Switching PassBook to the new token' },
  ],
});
