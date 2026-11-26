import { IDP_COPY } from './idp.ts';

/** Platform words for Polaris ID: sync status, differences, the calls ledger and groups. */

/** What a difference between Polaris ID and PassBook means, by kind. */
export const DRIFT_KIND: Record<string, { label: string; hint: string }> = {
  missing: { label: 'Missing', hint: 'PassBook wants it; Polaris ID does not have it.' },
  unexpected: { label: 'Extra', hint: 'Polaris ID has it; no reason in PassBook wants it.' },
  external_added: { label: IDP_COPY.account.external, hint: 'Kept. PassBook never removes it.' },
  owner_removed: { label: 'Removed in Polaris ID', hint: 'The role is paused until restored.' },
  disabled_in_idp: { label: IDP_COPY.account.disabled, hint: 'The account is off there.' },
  admin_changed: { label: 'Admin changed', hint: 'PassBook never touches admins.' },
  unknown_member: { label: 'Unknown member', hint: 'No PassBook user has this account.' },
  apply_failed: { label: 'Change failed', hint: 'Polaris ID refused the last change.' },
};

/** The binding's call budgets, by bucket. */
export const BUDGET_LABEL: Record<string, string> = {
  snapshot: 'Group reads',
  snapshot_group: 'Group reads (one group)',
  health: 'Health reads',
  lookup: 'Lookups',
  createSignup: 'Sign-up links',
  findByVerifiedEmail: 'Email lookups',
  apply_add: 'Role adds',
  apply_add_system: 'Role adds (system)',
  apply_add_group: 'Group adds',
  apply_add_group_system: 'Group adds (system)',
  apply_remove: 'Role removals',
  apply_override: 'Forced removals',
  setDisabled: 'Account disables',
  proveSignup: 'Sign-up checks',
  deleteSignup: 'Sign-up deletes',
  preview: 'Previews',
  group_write: 'Group changes',
  claims_write: 'Claim writes',
  claims_read: 'Claim reads',
};

/** Findings the binding reports about itself, by code prefix. */
export const PROBLEM_LABEL: Record<string, string> = {
  client_open: 'The PassBook app in Polaris ID is open to everyone.',
  default_claims_managed: 'A managed claim is also set by default.',
  role_unplaced: 'A role has no group in Polaris ID.',
  blocked: 'Changes to this group are blocked.',
  group_name_mismatch: 'A group name differs from its setting.',
  group_not_found: 'A configured group is not in Polaris ID.',
};

export const CALL_PHASE: Record<string, string> = {
  start: 'Started',
  end: 'Done',
  refused: 'Refused',
  budget: 'Over budget',
  dry_run: 'Dry run',
  breaker: 'Breaker',
};

/** Why a group cannot be written or deleted. */
export const GROUP_FLAG: Record<string, string> = {
  group_not_found: 'Not in Polaris ID yet.',
  group_name_mismatch: 'Its name in Polaris ID differs. Writes are blocked.',
};

export const GROUP_COPY = {
  keyFixed: "Group name can't change after it's created.",
  otherApps: 'Other apps that use this group lose it.',
  noRules: 'No org rules.',
  noMembers: 'No manual members.',
  hasMembers: 'Has members.',
  hasRules: 'Has org rules.',
  usedByOthers: 'Used by other apps in Polaris ID.',
  roleGroup: "A role group can't be deleted.",
  adoptedGroup: "An adopted group can't be deleted.",
} as const;

/** The Polaris ID name a custom group gets in every app's `groups` claim. */
export const groupName = (key: string): string => `passbook_g_${key}`;

/** `Group` → key suggestion: lowercase, digits and `_`, starting with a letter. */
export function keyFromName(name: string): string {
  const key = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '');
  return key.slice(0, 40);
}
