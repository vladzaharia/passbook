const brand: unique symbol = Symbol('job-authority');

/** Proof that a context came from queue, cron or workflow code. Routes never hold one. */
export interface JobAuthority {
  readonly [brand]: true;
}

const token: JobAuthority = Object.freeze({ [brand]: true as const });

/**
 * Adds the brand to a context. Only `service-context.ts` imports this (`createJobContext`); the
 * `job-authority-import` rule of `tools/authority-scope.ts` fails any other importer.
 */
export function withJobAuthority<T extends object>(ctx: T): T & { job: JobAuthority } {
  return { ...ctx, job: token };
}

export function hasJobAuthority(ctx: { job?: JobAuthority | undefined }): boolean {
  return ctx.job === token;
}
