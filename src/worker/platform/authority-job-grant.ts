import { AuthorityError } from './authority-error.ts';
import { type GrantInput, jobPrincipal } from './authority-granted.ts';
import type { Mode } from './authority-principal.ts';

const JOB_PURPOSE = /\.job\./;

export interface JobGrantInput extends Omit<GrantInput, 'principal'> {
  job: string;
  orgId?: string;
  mode?: Mode;
  orgAccessRevision?: number;
  inactiveOk?: true;
  /** A closed org too (status deleted): see CLOSED_OK_PURPOSES. */
  closedOk?: true;
}

// What each always-run provider purpose writes (PE5a/PE5b): a revoke claim or defer touches operations; a result
// settles operations, outcomes, targets and the revoked instance; staging a retirement moves instances and operations.
const WALLET_REVOKE_TABLES = ['wallet_provider_instance_operations'] as const;
const WALLET_RECORD_TABLES = [
  'wallet_provider_instances',
  'wallet_provider_instance_operations',
  'wallet_provider_instance_outcomes',
  'wallet_provider_sync_targets',
] as const;
const WALLET_RETIRE_TABLES = [
  'wallet_provider_instances',
  'wallet_provider_instance_operations',
] as const;

/** The purposes that may act while the org is suspended, with the tables each may write. */
const INACTIVE_OK_PURPOSES: Readonly<Record<string, readonly string[]>> = {
  'org_mode.job.pass_import.finish': ['pass_imports', 'counters'],
  'org_mode.job.pass_import.retention_clear': ['pass_imports', 'pass_import_rows'],
  'org_mode.job.pass_import.retention_delete': ['pass_imports', 'pass_import_rows'],
  // A channel-apply run of a suspended org still ends (as failed); it writes nothing else.
  'org_mode.job.channels.fail': ['channel_apply_runs'],
  // Closing a failed run journals its marks first, whatever the org's state.
  'org_mode.job.channels.journal_close': ['channel_apply_marks'],
  // A suspended org's enrolments are held, disabled and migrated all the same (design-wallet-accounts.md).
  'org_mode.job.wallet.enrolment_hold': ['wallet_provider_accounts', 'wallet_enrolment_events'],
  'org_mode.job.wallet.enrolment_disable': ['wallet_provider_accounts', 'wallet_enrolment_events'],
  'org_mode.job.wallet.credential_migrate': [
    'wallet_credentials',
    'wallet_credential_versions',
    'wallet_credential_events',
    'wallet_enrolment_events',
    'wallet_provider_accounts',
  ],
  // Provider queue work (PE5a/PE5b): a suspended org's results are recorded, its revocations run, and its
  // retirements are staged all the same. A queued upsert never runs for it (`org_mode.job.wallet.sync` is active-only).
  'org_mode.job.wallet.revoke': WALLET_REVOKE_TABLES,
  'org_mode.job.wallet.record': WALLET_RECORD_TABLES,
  'org_mode.job.wallet.retire': WALLET_RETIRE_TABLES,
};

/**
 * The one purpose that acts on a closed org, with the tables it may write: the org purge voids the org's
 * passes (the last version devices fetch) before it removes them. It holds only while the org is in purge
 * and under no legal hold; the generic publish purpose never does.
 */
const CLOSED_OK_PURPOSES: Readonly<Record<string, readonly string[]>> = {
  'org_mode.job.org.purge_void': ['passes', 'scan_code_rotations'],
  // Revoking a closed org's provider cards is not optional (design D10).
  'org_mode.job.wallet.revoke': WALLET_REVOKE_TABLES,
  'org_mode.job.wallet.record': WALLET_RECORD_TABLES,
  'org_mode.job.wallet.retire': WALLET_RETIRE_TABLES,
};

/** The checked input of a `system:` grant: a job purpose, `inactiveOk` only where allowlisted, the job principal. */
export function jobGrantInputOf(input: JobGrantInput): GrantInput {
  if (!JOB_PURPOSE.test(input.purpose))
    throw new AuthorityError(
      'GRANT_BAD_PURPOSE',
      'A job grant purpose names a job: <scope>.job.<name>.',
    );
  if (input.inactiveOk) {
    const allowed = INACTIVE_OK_PURPOSES[input.purpose];
    if (!allowed || !input.tables?.every((t) => allowed.includes(t)))
      throw new AuthorityError('GRANT_BAD_PURPOSE', 'inactiveOk is for allowlisted purposes.');
  }
  if (input.closedOk) {
    const allowed = CLOSED_OK_PURPOSES[input.purpose];
    if (!allowed || !input.tables?.every((t) => allowed.includes(t)))
      throw new AuthorityError('GRANT_BAD_PURPOSE', 'closedOk is for allowlisted purposes.');
  }
  const { job, orgId, mode, orgAccessRevision, inactiveOk, closedOk, ...rest } = input;
  const principal = jobPrincipal({ job, orgId, mode, orgAccessRevision, inactiveOk, closedOk });
  return { ...rest, principal };
}
