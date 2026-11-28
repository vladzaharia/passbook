// The only module that builds guarded writes. Contract: docs/design/authority-epochs.md section 1.2.
import { AuthorityError } from './authority-error.ts';
import { Grant } from './authority-grant.ts';
import { assertDeferredContext, type GrantInput, scopeOf } from './authority-granted.ts';
import { type JobGrantInput, jobGrantInputOf } from './authority-job-grant.ts';
import { assertJobGrantAllowed, hasFullJobAuthority } from './job-authority.ts';
import type { ServiceContext } from './service-context.ts';

export type { AuditRow } from './authority-audit.ts';
/** Test-only: the prepared statements of a grant, to inspect or break a batch. */
export { grantedBatch, prepareOf as prepareGrantForTest } from './authority-batch.ts';
export { Grant } from './authority-grant.ts';
export type { GrantedStatement, GrantInput } from './authority-granted.ts';
export { authorityDenial, sweepLeakedGrants } from './authority-granted.ts';
export type { JobGrantInput } from './authority-job-grant.ts';

/** A tenant, API-key, scanner or platform-admin grant. `system:` principals use `jobGrant`. */
export function grant(ctx: ServiceContext, input: GrantInput): Grant {
  if (input.principal.kind === 'system')
    throw new AuthorityError('GRANT_NOT_JOB', 'System grants come from jobGrant().');
  const scope = scopeOf(input);
  assertDeferredContext(hasFullJobAuthority(ctx), input);
  const p = input.principal;
  const full = { ...input, ...(p.kind === 'holder' ? { target: p.passId } : {}), via: ctx.via };
  return new Grant(ctx.env.DB, ctx.ids.token(), scope, full, ctx.clock.now());
}

/** Only a context built by `createJobContext` (queue, cron, workflow) can mint a `system:` grant. */
export function jobGrant(ctx: ServiceContext, input: JobGrantInput): Grant {
  assertJobGrantAllowed(ctx.job, input.purpose);
  const full = jobGrantInputOf(input);
  return new Grant(ctx.env.DB, ctx.ids.token(), scopeOf(full), full, ctx.clock.now());
}
