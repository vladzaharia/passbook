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
}

/** The purposes that may act while the org is suspended, with the tables each may write. */
const INACTIVE_OK_PURPOSES: Readonly<Record<string, readonly string[]>> = {
  'org_mode.job.pass_import.finish': ['pass_imports', 'counters'],
  'org_mode.job.pass_import.retention_clear': ['pass_imports', 'pass_import_rows'],
  'org_mode.job.pass_import.retention_delete': ['pass_imports', 'pass_import_rows'],
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
  const { job, orgId, mode, orgAccessRevision, inactiveOk, ...rest } = input;
  const principal = jobPrincipal({ job, orgId, mode, orgAccessRevision, inactiveOk });
  return { ...rest, principal };
}
