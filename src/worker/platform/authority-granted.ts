// Grant plumbing shared by authority.ts: the opaque statement type and the grant-insert SQL.
import type { Check } from './authority-checks.ts';
import { AuthorityError } from './authority-error.ts';
import {
  actorSql,
  Binds,
  type GrantScope,
  type Mode,
  missingReason,
  type Principal,
  principalLabel,
} from './authority-principal.ts';
import { assertBudget, type BuiltStatement, PARAM_BUDGET } from './authority-statements.ts';
import type { DenialOptions, DenyReason } from './errors.ts';
import { DENY_REASONS } from './errors.ts';
import type { ServiceContext } from './service-context.ts';

export interface GrantInput {
  /** `<scope>.<area>.<action>`, for example `org_mode.pass.publish`. */
  purpose: string;
  principal: Principal;
  target?: string;
  checks?: Check[];
  /** Per-purpose HTTP codes for refusals, for example `{ stale: 'PASS_CHANGED' }`. */
  codes?: DenialOptions['codes'];
  /**
   * The only tables this grant's writes may target (audit rows are always allowed). A fixed-purpose factory
   * lists the tables its work writes, so the purpose is a bound and not only a label.
   */
  tables?: readonly string[];
}

/** Held only by `platform/authority*.ts`: without it no other module can construct a statement. */
export const BUILDER = Symbol('authority-builder');

const registry = new WeakMap<GrantedStatement, { grantId: string } & BuiltStatement>();

/**
 * A guarded write that is not a D1 statement. It carries its grant's id and can only be committed
 * through that grant's batch, so it can never run on its own or inside another grant's batch.
 */
export class GrantedStatement {
  constructor(token: typeof BUILDER, grantId: string, built: BuiltStatement) {
    if (token !== BUILDER)
      throw new AuthorityError(
        'GRANT_FOREIGN_STATEMENT',
        'Statements are built by the grant (update, insertSelect, audit, unguarded), never constructed.',
      );
    registry.set(this, { grantId, ...built });
  }
  private outside(): never {
    throw new AuthorityError(
      'GRANT_STATEMENT_OUTSIDE_BATCH',
      'A granted statement runs only inside its grant batch.',
    );
  }
  run(): never {
    return this.outside();
  }
  first(): never {
    return this.outside();
  }
  all(): never {
    return this.outside();
  }
  bind(): never {
    return this.outside();
  }
}

export function builtOf(s: GrantedStatement): { grantId: string } & BuiltStatement {
  const built = registry.get(s);
  if (!built)
    throw new AuthorityError('GRANT_FOREIGN_STATEMENT', 'Not a statement built by a grant.');
  return built;
}

function deniedSql(scope: GrantScope, p: Principal, checks: Check[], b: Binds): string {
  const when = (reason: DenyReason) => {
    const parts = checks
      .filter((c) => c.reason === reason)
      .map((c) => `COALESCE((${c.ok(b, scope)}), 0) = 1`);
    return parts.length > 0 ? [`WHEN NOT (${parts.join(' AND ')}) THEN '${reason}'`] : [];
  };
  const whens = [
    `WHEN a.org_ok IS NULL THEN '${missingReason(p)}'`,
    `WHEN a.org_ok = 0 THEN 'org'`,
    ...when('org'),
  ];
  if (scope !== 'platform') whens.push(`WHEN a.org_id IS NULL THEN 'actor'`);
  whens.push(`WHEN a.actor_ok = 0 THEN 'actor'`);
  if (scope === 'platform' && p.kind === 'api_key')
    whens.push(`WHEN a.org_id IS NOT NULL THEN 'actor'`);
  whens.push(...when('actor'));
  for (const reason of DENY_REASONS.slice(2)) whens.push(...when(reason));
  return `CASE ${whens.join(' ')} END`;
}

export function grantInsert(
  id: string,
  scope: GrantScope,
  input: GrantInput,
  extra: Check[],
  now: number,
): BuiltStatement {
  const b = new Binds();
  const actor = actorSql(input.principal, now, b);
  const idP = b.bind(id);
  const scopeP = b.bind(scope);
  const label = b.bind(principalLabel(input.principal));
  const purpose = b.bind(input.purpose);
  const target = b.bind(input.target ?? null);
  const denied = deniedSql(scope, input.principal, [...(input.checks ?? []), ...extra], b);
  const created = b.bind(now);
  const guard = b.bind(id);
  const sql = `WITH actor AS MATERIALIZED (${actor})
    INSERT INTO authority_grants (id, scope, org_id, mode, principal, purpose, target_id, denied, created_at, leak_guard)
    SELECT ${idP}, ${scopeP}, ${scope === 'platform' ? 'NULL' : 'a.org_id'}, ${scope === 'org_mode' ? 'a.mode' : 'NULL'},
      ${label}, ${purpose}, ${target}, ${denied}, ${created}, ${guard}
    FROM (SELECT 1 AS one) AS one LEFT JOIN actor AS a ON 1 = 1`;
  assertBudget(sql, b.params, PARAM_BUDGET);
  return { sql, params: b.params };
}

const PURPOSE = /^(org_mode|org|platform)\.[a-z0-9_]+(\.[a-z0-9_]+)+$/;

/** The scope a purpose names, checked against the principal that may hold it. */
export function scopeOf(input: GrantInput): GrantScope {
  const match = PURPOSE.exec(input.purpose);
  if (!match) throw new AuthorityError('GRANT_BAD_PURPOSE', `Bad grant purpose: ${input.purpose}`);
  const scope = match[1] as GrantScope;
  const p = input.principal;
  if (scope === 'platform' && (p.kind === 'membership' || p.kind === 'scanner'))
    throw new AuthorityError(
      'GRANT_BAD_PRINCIPAL',
      'A membership or scanner cannot hold a platform grant.',
    );
  if (p.kind === 'holder') assertHolderGrant(scope, p, input);
  if (scope === 'platform' && p.kind === 'api_key' && p.orgId !== undefined)
    throw new AuthorityError('GRANT_BAD_PRINCIPAL', 'A platform grant names no org.');
  if (
    scope === 'org_mode' &&
    p.kind !== 'api_key' &&
    p.kind !== 'scanner' &&
    p.kind !== 'holder' &&
    p.mode === undefined
  )
    throw new AuthorityError(
      'GRANT_BAD_PRINCIPAL',
      'An org_mode grant needs a mode for this principal.',
    );
  if (
    (p.kind === 'platform' || p.kind === 'system') &&
    scope !== 'platform' &&
    p.orgId === undefined
  )
    throw new AuthorityError(
      'GRANT_BAD_PRINCIPAL',
      'A platform or system actor names its target org.',
    );
  return scope;
}

/** A deferred membership principal comes from a job context, or names `allowRequestContext`. */
export function assertDeferredContext(isJob: boolean, input: GrantInput): void {
  const p = input.principal;
  if (p.kind !== 'membership' || p.via !== 'deferred' || isJob) return;
  if (p.allowRequestContext === true) return;
  throw new AuthorityError(
    'GRANT_BAD_PRINCIPAL',
    'A deferred principal is built in a queue, cron or workflow context.',
  );
}

const HOLDER_PURPOSES = {
  session: 'org_mode.pass.holder_remove',
  verified_email: 'org_mode.pass.holder_attach',
  device: 'org_mode.pass.personalize',
} as const;

/** A holder grant is org_mode, has the one purpose its proof allows, and its target is its pass. */
function assertHolderGrant(
  scope: GrantScope,
  p: Extract<Principal, { kind: 'holder' }>,
  input: GrantInput,
): void {
  if (scope !== 'org_mode' || input.purpose !== HOLDER_PURPOSES[p.proof.via])
    throw new AuthorityError(
      'GRANT_BAD_PRINCIPAL',
      `A ${p.proof.via} holder holds ${HOLDER_PURPOSES[p.proof.via]} only.`,
    );
  if (input.target !== undefined && input.target !== p.passId)
    throw new AuthorityError('GRANT_BAD_PRINCIPAL', "A holder grant's target is its pass.");
}

/** The reason of an `authority_denied:*` abort, or null for any other error. */
export function authorityDenial(error: unknown): string | null {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : '';
  return /authority_denied:([a-z]+)/.exec(message)?.[1] ?? null;
}

/** A grant row that survives its batch is a builder bug: delete it and log it. */
export async function sweepLeakedGrants(ctx: ServiceContext): Promise<number> {
  const result = await ctx.env.DB.prepare('DELETE FROM authority_grants').run();
  const leaked = result.meta.changes ?? 0;
  if (leaked > 0) ctx.log.error('authority.grant_leak', { code: 'AUTHORITY_GRANT_LEAK', leaked });
  return leaked;
}

/** The `system:` principal of a job grant. */
export function jobPrincipal(j: {
  job: string;
  orgId: string | undefined;
  mode: Mode | undefined;
  orgAccessRevision: number | undefined;
}): Principal {
  return {
    kind: 'system',
    job: j.job,
    ...(j.orgId === undefined ? {} : { orgId: j.orgId }),
    ...(j.mode === undefined ? {} : { mode: j.mode }),
    ...(j.orgAccessRevision === undefined ? {} : { orgAccessRevision: j.orgAccessRevision }),
  };
}
