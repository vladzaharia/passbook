import { type Grant, jobGrant } from '../platform/authority.ts';
import type { Check } from '../platform/authority-checks.ts';
import { createJobContext, type ServiceContext } from '../platform/service-context.ts';

/** A refused write means the person or the sandbox changed between the read and the commit. */
const CODES = {
  actor: 'SANDBOX_ACTOR_CHANGED',
  config: 'SANDBOX_CONFLICT',
  stale: 'SANDBOX_CONFLICT',
};

export const SANDBOX_CREATE_TABLES = [
  'orgs',
  'org_entitlements',
  'org_invitations',
  'org_memberships',
  'developer_sandboxes',
] as const;

const TABLES = {
  'platform.job.developer_sandbox.create': SANDBOX_CREATE_TABLES,
  'platform.job.developer_sandbox.close': ['orgs', 'api_keys', 'developer_sandboxes'],
  'platform.job.developer_sandbox.try_revoke': ['developer_sandboxes'],
  'platform.job.developer_sandbox.funnel': ['developer_sandboxes'],
  'platform.job.developer_sandbox.restart': ['developer_sandboxes', 'api_keys'],
  'platform.job.developer_sandbox.reset_rows': ['webhook_captures'],
  'platform.job.developer_sandbox.reset_key': ['developer_sandboxes'],
  'platform.job.developer_sandbox.reopen': ['orgs', 'developer_sandboxes'],
  'platform.job.developer_sandbox.delete': ['orgs', 'api_keys', 'developer_sandboxes'],
} as const;

/**
 * The `system:` grants a request may trigger for developer sandboxes: making one (a person who proved a live
 * session, Turnstile and the rest in the request), closing one (its person or the daily sweep), ending its try
 * tokens (its person), stamping its funnel columns (its person, set once), restarting its quickstart track (a reset) and reopening it (its person, inside the window). Fixed purposes and tables; the job context never leaves this function, and
 * `tools/authority-scope.ts` allows only `modules/developer/repo-grants.ts` to import it.
 */
export function developerSandboxGrant(
  ctx: ServiceContext,
  purpose:
    | 'platform.job.developer_sandbox.create'
    | 'platform.job.developer_sandbox.close'
    | 'platform.job.developer_sandbox.try_revoke'
    | 'platform.job.developer_sandbox.funnel'
    | 'platform.job.developer_sandbox.restart'
    | 'platform.job.developer_sandbox.reset_rows'
    | 'platform.job.developer_sandbox.reset_key'
    | 'platform.job.developer_sandbox.reopen'
    | 'platform.job.developer_sandbox.delete',
  checks: Check[],
  orgId?: string,
): Grant {
  const job: ServiceContext = {
    ...createJobContext(ctx.env, 'developer-sandbox', { clock: ctx.clock, log: ctx.log }),
    ids: ctx.ids,
    requestId: ctx.requestId,
    waitUntil: ctx.waitUntil,
  };
  return jobGrant(job, {
    job: 'developer-sandbox',
    purpose,
    codes: CODES,
    checks,
    tables: TABLES[purpose],
    ...(orgId === undefined ? {} : { orgId }),
  });
}
