import { AuthorityError } from './authority-error.ts';

const brand: unique symbol = Symbol('job-authority');

/** Proof that a context came from queue, cron or workflow code. Routes never hold one. */
export interface JobAuthority {
  readonly [brand]: true;
  /** When set, `jobGrant` refuses every other purpose (a request-triggered job context is narrowed). */
  readonly allowedPurposes?: readonly string[];
}

const token: JobAuthority = Object.freeze({ [brand]: true as const });
const narrowed = new WeakSet<JobAuthority>();

/**
 * Adds the brand to a context. Only `service-context.ts` imports this (`createJobContext`); the
 * `job-authority-import` rule of `tools/authority-scope.ts` fails any other importer.
 */
export function withJobAuthority<T extends object>(
  ctx: T,
  allowedPurposes?: readonly string[],
): T & { job: JobAuthority } {
  if (!allowedPurposes) return { ...ctx, job: token };
  const own: JobAuthority = Object.freeze({
    [brand]: true as const,
    allowedPurposes: Object.freeze([...allowedPurposes]),
  });
  narrowed.add(own);
  return { ...ctx, job: own };
}

/** A job context with no purpose narrowing: the only kind that may mint deferred grants and creates. */
export function hasFullJobAuthority(ctx: { job?: JobAuthority | undefined }): boolean {
  return ctx.job === token;
}

export function hasJobAuthority(ctx: { job?: JobAuthority | undefined }): boolean {
  return ctx.job === token || (ctx.job !== undefined && narrowed.has(ctx.job));
}

/** `jobGrant`'s entry check: a job context, and for a narrowed one (first tap) only its own purposes. */
export function assertJobGrantAllowed(job: JobAuthority | undefined, purpose: string): void {
  if (!hasJobAuthority({ job }))
    throw new AuthorityError('GRANT_NOT_JOB', 'jobGrant needs a queue, cron or workflow context.');
  if (job?.allowedPurposes && !job.allowedPurposes.includes(purpose))
    throw new AuthorityError(
      'GRANT_PURPOSE_NOT_ALLOWED',
      `This job context may not use ${purpose}.`,
    );
}
