import type { SetupItemKey } from '../contracts/idp-setup.ts';

/** Words for the Polaris ID Set up card: the 12 items, why one waits or stops, and the owner's runbooks. */
export const SETUP_LABEL: Record<SetupItemKey, string> = {
  binding: 'Polaris ID reachable',
  polaris_settings: 'Polaris ID settings',
  client: 'PassBook app in Polaris ID',
  groups: 'Groups',
  client_groups: 'Allowed groups',
  client_restricted: 'Only these groups',
  client_logo: 'App logo',
  scim_token: 'SCIM token',
  scim_provider: 'SCIM connection',
  scim_sync: 'First sync',
  scim_mirror: 'Directory copy',
  write_mode: 'Write mode',
};

/** Why an item is blocked, by the binding's stable word. A `:role` suffix is added by the card. */
export const SETUP_REASON: Record<string, string> = {
  frozen: 'Changes are paused.',
  layout_suspect: 'Polaris ID is not laid out as expected.',
  binding_absent: 'The connector is not deployed.',
  idp_auth: 'Polaris ID refused the key.',
  client_not_found: 'Sign in with Polaris ID once.',
  client_not_cimd: 'The app is not set up from a metadata URL.',
  client_not_ours: 'The app belongs to something else.',
  client_foreign_callbacks: 'The app has callbacks outside PassBook.',
  group_in_use: 'is used by another app.',
  group_missing: 'group is missing.',
  admin_group_missing: 'The platform admin group is missing.',
  scim_endpoint_foreign: 'The connection points elsewhere.',
  scim_mirror_empty: 'No users or groups have arrived.',
};

export const SETUP_ROW_STATE: Record<string, string> = {
  placed: 'Placed',
  allowed: 'Allowed',
  needed: 'Needed',
};

const RUNBOOKS = 'https://github.com/vladzaharia/passbook/blob/main/docs/runbooks';
const runbook = (name: string) => `${RUNBOOKS}/${name}.md`;

/** The runbook for a step only the owner can do, by item and reason word. */
export function setupRunbook(key: SetupItemKey, reason: string | undefined): string | null {
  const word = (reason ?? '').split(':')[0] ?? '';
  if (key === 'write_mode') return runbook('passbook-id-connector-go-live');
  if (word === 'frozen') return runbook('passbook-id-connector-thaw');
  if (word === 'idp_auth') return runbook('passbook-id-connector-key-rotation');
  if (word === 'binding_absent' || word === 'layout_suspect' || word === 'admin_group_missing')
    return runbook('passbook-id-connector-turn-on');
  if (word === 'scim_endpoint_foreign') return runbook('scim-receiver-setup');
  if (key === 'polaris_settings' || key === 'client' || word.startsWith('group_'))
    return runbook('go-live-polaris-id');
  return null;
}
