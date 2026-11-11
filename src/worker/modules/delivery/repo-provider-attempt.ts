import { grantedBatch } from '../../platform/authority.ts';
import { gt } from '../../platform/authority-expr.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { DELIVERY_CODES, deliveryGrants } from './delivery-actor.ts';
import { EMAIL_OUTCOME_UNKNOWN } from './repo-binding.ts';
import type { EmailOutput } from './repo-issuance-intent-fence.ts';

const ORG_CODE = 'ORG_INACTIVE';
const ACTOR_CODE = 'ACTOR_REVOKED';
const CODES = { ...DELIVERY_CODES, org: ORG_CODE, actor: ACTOR_CODE };

/** Why the provider boundary was not crossed; each maps to the code the outbox row is cancelled with. */
export type AttemptResult = 'started' | 'lost' | 'stale' | 'org' | 'actor';

export const ATTEMPT_CANCEL_CODE: Record<Exclude<AttemptResult, 'started'>, string> = {
  lost: 'DELIVERY_STALE',
  stale: 'DELIVERY_STALE',
  org: 'ORG_INACTIVE',
  actor: 'ACTOR_REVOKED',
};

/**
 * Marks the irreversible provider boundary under a grant for the actor captured at queue time and
 * the lineage checks of `output`. The marker is written only while the lease is valid and the actor,
 * org and pass lineage hold now; a revoked membership, disabled user, suspended org, transfer or
 * quarantine refuses it. A committed marker is never retried.
 */
export async function beginProviderAttempt(
  ctx: ServiceContext,
  input: {
    id: string;
    lease: string;
    orgId: string;
    mode: 'live' | 'test';
    passId: string;
    output: EmailOutput;
    now: number;
  },
): Promise<AttemptResult> {
  const grants = deliveryGrants(ctx, [input.output.actor, input.output.also], {
    action: 'email_send',
    orgId: input.orgId,
    mode: input.mode,
    checks: input.output.checks,
    target: input.id,
    codes: CODES,
  });
  grants[0]?.update('outbox', {
    set: { error_code: EMAIL_OUTCOME_UNKNOWN },
    where: {
      id: input.id,
      kind: 'email',
      state: 'processing',
      lease: input.lease,
      provider_id: null,
      available_at: gt(input.now),
      pass_id: input.passId,
    },
    returning: ['id'],
  });
  try {
    const [writes] = await grantedBatch(ctx.env.DB, grants);
    const result = writes?.[0];
    return (result?.results.length ?? 0) === 1 ? 'started' : 'lost';
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code === ORG_CODE) return 'org';
    if (error.code === ACTOR_CODE) return 'actor';
    if (error.code === 'DELIVERY_STALE') return 'stale';
    throw error;
  }
}
