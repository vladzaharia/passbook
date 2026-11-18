import { type Grant, grant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { JOIN_PURPOSE, JOIN_TABLES } from '../../platform/authority-granted.ts';
import type { DenyReason } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { joinChecks } from './repo-grant.ts';

/** What each refusal of a join create means to the public submit path. */
export const JOIN_CODES = {
  org: 'ORG_ACCESS_CHANGED',
  actor: 'JOIN_LINK_CLOSED',
  config: 'JOIN_LIMIT',
  lineage: 'JOIN_DUPLICATE',
  release: 'JOIN_NOT_READY',
  stale: 'CREATE_STALE',
} as const satisfies Partial<Record<DenyReason, string>>;

export interface JoinCreateInput {
  linkId: string;
  generation: number;
  /** The platform's per-org daily cap for the link's mode, read at request time. */
  orgDailyCap: number;
  templateId: string;
  passId: string;
  holderEmail: string | null;
  now: number;
  /** The release, blueprint and snapshot checks every pass create holds. */
  checks: Check[];
}

/**
 * The grant of a public join create: pinned to the new pass, insert only. The link's template, the per-link
 * and per-org rolling-24h caps, and the one-active-card-per-address rule are checks that commit with the
 * pass, so no concurrent submit overshoots a cap.
 */
export function joinCreateGrant(ctx: ServiceContext, input: JoinCreateInput): Grant {
  const { linkId } = input;
  const checks = [...input.checks, ...joinChecks(input)];
  return grant(ctx, {
    purpose: JOIN_PURPOSE,
    principal: { kind: 'join', linkId, generation: input.generation },
    target: input.passId,
    checks,
    codes: JOIN_CODES,
    tables: JOIN_TABLES,
  });
}
