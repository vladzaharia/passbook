// Grant plumbing shared by authority.ts: the opaque statement type and the grant-insert SQL.
import type { Check } from './authority-checks.ts';
import { AuthorityError } from './authority-error.ts';
import { CREATOR_ORG_PURPOSE, PERSONAL_ORG_PURPOSE } from './authority-personal.ts';
import {
  actorSql,
  Binds,
  type GrantScope,
  type HolderProof,
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
  /** Set by `grant()` from the context: a try-token request marks its audit rows (`detail.via`). */
  via?: 'try' | 'cli';
}

/** Module-local: only `newGrantedStatement` holds it, so no other module can construct a statement. */
const BUILDER = Symbol('authority-builder');

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
        'Statements are built by the grant (update, insertSelect, audit, include), never constructed.',
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

/** The grant builder's statement factory. Only `platform/authority*.ts` may call it (lint `builder-internal`). */
export const newGrantedStatement = (grantId: string, built: BuiltStatement): GrantedStatement =>
  new GrantedStatement(BUILDER, grantId, built);

export function builtOf(s: GrantedStatement): { grantId: string } & BuiltStatement {
  const built = registry.get(s);
  if (!built)
    throw new AuthorityError('GRANT_FOREIGN_STATEMENT', 'Not a statement built by a grant.');
  return built;
}

function deniedSql(
  scope: GrantScope,
  p: Principal,
  checks: Check[],
  b: Binds,
  limitedRefused: boolean,
): string {
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
  // A developer org never holds Live: a Live request there is a 409, not a lost-access 403.
  whens.push(
    `WHEN a.actor_ok = 0 AND a.mode = 'live' AND EXISTS (SELECT 1 FROM orgs d WHERE d.id = a.org_id AND d.kind = 'developer') THEN 'testonly'`,
  );
  whens.push(`WHEN a.actor_ok = 0 THEN 'actor'`);
  // A key limited to templates holds no grant that writes a table with no template dimension.
  if (limitedRefused) whens.push(`WHEN a.limit_key IS NOT NULL THEN 'actor'`);
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
  /** A statement of the grant writes a table a limited key may not (`keyMayWrite`). */
  limitedRefused = false,
): BuiltStatement {
  const b = new Binds(input.principal.kind === 'api_key');
  const actor = actorSql(input.principal, now, b);
  const idP = b.bind(id);
  const scopeP = b.bind(scope);
  const label = b.bind(principalLabel(input.principal));
  const purpose = b.bind(input.purpose);
  const target = b.bind(input.target ?? null);
  const denied = deniedSql(
    scope,
    input.principal,
    [...(input.checks ?? []), ...extra],
    b,
    limitedRefused,
  );
  const created = b.bind(now);
  const guard = b.bind(id);
  const sql = `WITH actor AS MATERIALIZED (${actor})
    INSERT INTO authority_grants (id, scope, org_id, mode, principal, purpose, target_id, denied, created_at, leak_guard, limit_key)
    SELECT ${idP}, ${scopeP}, ${scope === 'platform' ? 'NULL' : 'a.org_id'}, ${scope === 'org_mode' ? 'a.mode' : 'NULL'},
      ${label}, ${purpose}, ${target}, ${denied}, ${created}, ${guard}, a.limit_key
    FROM (SELECT 1 AS one) AS one LEFT JOIN actor AS a ON 1 = 1`;
  assertBudget(sql, b.params, PARAM_BUDGET);
  return { sql, params: b.params };
}

const PURPOSE = /^(org_mode|org|platform)\.[a-z0-9_]+(\.[a-z0-9_]+)+$/;

/** Purposes only a platform admin session holds: no org principal, key or job. */
const PLATFORM_ADMIN_PURPOSES: readonly string[] = [
  PERSONAL_ORG_PURPOSE,
  CREATOR_ORG_PURPOSE,
  'org_mode.wallet.enrolment_hold',
  'org_mode.wallet.enrolment_release',
  'org_mode.wallet.migration_resolve',
];

/** The purposes a platform admin may run on a suspended org: offboarding ends what the user holds there. */
const INACTIVE_OK_PLATFORM: readonly string[] = ['org.member.revoke', 'org.developer.remove'];

/** The scope a purpose names, checked against the principal that may hold it. */
export function scopeOf(input: GrantInput): GrantScope {
  const match = PURPOSE.exec(input.purpose);
  if (!match) throw new AuthorityError('GRANT_BAD_PURPOSE', `Bad grant purpose: ${input.purpose}`);
  const scope = match[1] as GrantScope;
  const p = input.principal;
  if (p.kind === 'platform' && p.inactiveOk && !INACTIVE_OK_PLATFORM.includes(input.purpose))
    throw new AuthorityError('GRANT_BAD_PURPOSE', 'inactiveOk is for allowlisted purposes.');
  if (PLATFORM_ADMIN_PURPOSES.includes(input.purpose) && p.kind !== 'platform')
    throw new AuthorityError(
      'GRANT_BAD_PRINCIPAL',
      `${input.purpose} is held by a platform admin only.`,
    );
  if (
    scope === 'platform' &&
    (p.kind === 'membership' || p.kind === 'scanner' || p.kind === 'join')
  )
    throw new AuthorityError(
      'GRANT_BAD_PRINCIPAL',
      'A membership, scanner or join link cannot hold a platform grant.',
    );
  if (p.kind === 'holder') assertHolderGrant(scope, p, input);
  assertJoinGrant(scope, p, input);
  if (scope === 'platform' && p.kind === 'api_key' && p.orgId !== undefined)
    throw new AuthorityError('GRANT_BAD_PRINCIPAL', 'A platform grant names no org.');
  if (
    scope === 'org_mode' &&
    p.kind !== 'api_key' &&
    p.kind !== 'scanner' &&
    p.kind !== 'holder' &&
    p.kind !== 'join' &&
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

const HOLDER_PURPOSES: Record<HolderProof['via'], readonly string[]> = {
  session: ['org_mode.pass.holder_remove', 'org_mode.nfc.tag.holder_lost'],
  verified_email: ['org_mode.pass.holder_attach'],
  device: ['org_mode.pass.personalize'],
  link: ['org_mode.pass.holder_print'],
};

/** A holder grant is org_mode, has the one purpose its proof allows, and its target is its pass. */
function assertHolderGrant(
  scope: GrantScope,
  p: Extract<Principal, { kind: 'holder' }>,
  input: GrantInput,
): void {
  if (scope !== 'org_mode' || !HOLDER_PURPOSES[p.proof.via].includes(input.purpose))
    throw new AuthorityError(
      'GRANT_BAD_PRINCIPAL',
      `A ${p.proof.via} holder holds ${HOLDER_PURPOSES[p.proof.via].join(' or ')} only.`,
    );
  if (input.target !== undefined && input.target !== p.passId)
    throw new AuthorityError('GRANT_BAD_PRINCIPAL', "A holder grant's target is its pass.");
}

/** The one purpose a join link holds, and the tables it may write: the create list plus the ledger. */
export const JOIN_PURPOSE = 'org_mode.pass.join';
export const JOIN_TABLES: readonly string[] = [
  'passes',
  'pass_events',
  'pass_issuance_deliveries',
  'pass_token_seals',
  'pass_auth_seals',
  'join_issues',
  'join_marks',
];

/**
 * A join principal holds `org_mode.pass.join` only, with a target (the new pass) and a table list inside
 * `JOIN_TABLES`; no other principal holds that purpose.
 */
function assertJoinGrant(scope: GrantScope, p: Principal, input: GrantInput): void {
  if (p.kind !== 'join') {
    if (input.purpose === JOIN_PURPOSE)
      throw new AuthorityError(
        'GRANT_BAD_PRINCIPAL',
        `${JOIN_PURPOSE} is held by a join link only.`,
      );
    return;
  }
  if (scope !== 'org_mode' || input.purpose !== JOIN_PURPOSE)
    throw new AuthorityError('GRANT_BAD_PRINCIPAL', `A join link holds ${JOIN_PURPOSE} only.`);
  if (input.target === undefined)
    throw new AuthorityError('GRANT_BAD_PRINCIPAL', "A join grant's target is the new pass.");
  if (!input.tables || input.tables.some((t) => !JOIN_TABLES.includes(t.toLowerCase())))
    throw new AuthorityError(
      'GRANT_BAD_PRINCIPAL',
      'A join grant lists tables, all of them in the create list.',
    );
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
  inactiveOk?: true | undefined;
  closedOk?: true | undefined;
}): Principal {
  return {
    kind: 'system',
    job: j.job,
    ...(j.orgId === undefined ? {} : { orgId: j.orgId }),
    ...(j.mode === undefined ? {} : { mode: j.mode }),
    ...(j.orgAccessRevision === undefined ? {} : { orgAccessRevision: j.orgAccessRevision }),
    ...(j.inactiveOk ? { inactiveOk: true as const } : {}),
    ...(j.closedOk ? { closedOk: true as const } : {}),
  };
}
