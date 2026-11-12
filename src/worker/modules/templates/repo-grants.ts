import { type Grant, type GrantedStatement, grant, jobGrant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { GUARDED_TABLES } from '../../platform/authority-tables.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { DenialOptions } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { membershipCapability, tenantPrincipal } from '../passes/repo-authority.ts';
import type { TemplateAuthority } from './access.ts';
import { userIsActiveAdmin } from './repo-grant-checks.ts';

/** Every table a template grant writes, typed or through `inGrant`. Anything else is refused. */
const TEMPLATE_TABLES = [
  'templates',
  'template_candidates',
  'template_approvals',
  'template_releases',
  'template_versions',
  'template_version_extras',
  'template_version_extra_sets',
  'template_version_hashes',
  'template_release_reissues',
  'template_imports',
  'workflow_runs',
  'scan_events',
  'settings',
] as const;

export interface TemplateGrantOptions {
  /** Request-bound codes for refusals (for example `{ stale: 'TEMPLATE_VERSION_CONFLICT' }`). */
  codes?: DenialOptions['codes'];
  target?: string;
  checks?: Check[];
  /**
   * Work queued earlier (an import): the member needs no live session, only an unrevoked membership and
   * the org `access_revision` captured with the work (owner answer 2). A platform administrator runs as
   * the import job, valid while the user is active.
   */
  deferred?: boolean;
}

export function templatePrincipal(authority: TemplateAuthority, deferred: boolean): Principal {
  if (authority.kind === 'platform')
    return {
      kind: 'platform',
      userId: authority.userId,
      sessionIdHash: authority.sessionId,
    };
  if (!deferred) return tenantPrincipal(authority);
  return {
    kind: 'membership',
    membershipId: authority.membershipId,
    via: 'deferred',
    orgAccessRevision: authority.orgUpdatedAt,
    // Work captured without the user's revision is refused, never revived.
    userAccessRevision: authority.userAccessRevision ?? 0,
    mode: authority.mode,
  };
}

/**
 * A grant for one captured template authority. A member holds an org grant (`org.template.<action>`)
 * and the membership's own roles must grant the captured capability; a platform administrator holds a
 * platform grant (`platform.template.<action>`) and needs a live admin session.
 */
export function templateGrant(
  ctx: ServiceContext,
  authority: TemplateAuthority,
  action: string,
  options: TemplateGrantOptions = {},
): Grant {
  const deferred = options.deferred === true;
  const shared = {
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.codes ? { codes: options.codes } : {}),
    tables: TEMPLATE_TABLES,
  };
  const extra = options.checks ?? [];
  if (authority.kind === 'session')
    return grant(ctx, {
      purpose: `org.template.${action}`,
      principal: templatePrincipal(authority, deferred),
      checks: [membershipCapability(authority.membershipId, authority.capability), ...extra],
      ...shared,
    });
  if (!deferred)
    return grant(ctx, {
      purpose: `platform.template.${action}`,
      principal: templatePrincipal(authority, false),
      checks: extra,
      ...shared,
    });
  return jobGrant(ctx, {
    job: 'template-import',
    purpose: `platform.job.template_${action}`,
    // Work captured without the user's revision is refused, never revived.
    checks: [userIsActiveAdmin(authority.userId, authority.userAccessRevision ?? 0), ...extra],
    ...shared,
  });
}

/**
 * The grants of one operation: check-only grants first (they see the state before the write), the
 * writing grant last. All share their refusal codes, so they commit as one batch (`grantedBatch`).
 */
export function templateGrants(
  ctx: ServiceContext,
  authorities: TemplateAuthority[],
  action: string,
  options: TemplateGrantOptions,
  writerIndex = 0,
): { writer: Grant; all: Grant[] } {
  const all = authorities.map((authority, i) =>
    templateGrant(ctx, authority, i === writerIndex ? action : `${action}_check`, {
      ...options,
      checks: i === writerIndex ? (options.checks ?? []) : [],
    }),
  );
  const writer = all[writerIndex];
  if (!writer) throw new Error('A template write needs an authority.');
  const ordered = [...all.filter((g) => g !== writer), writer];
  return { writer, all: ordered };
}

const WRITE_TARGET =
  /^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/i;

/**
 * A statement on an unguarded table (versions, hashes, extras) or a read that must run inside the
 * grant's batch. Guarded tables go through the builder; the SQL of a write must name its grant row.
 */
export function inGrant(g: Grant, sql: string, params: SqlValue[]): GrantedStatement {
  const table = WRITE_TARGET.exec(sql)?.[1];
  if (table !== undefined) {
    if (table in GUARDED_TABLES)
      throw new Error(`${table} is guarded: write it with the grant builder.`);
    if (!/authority_grants/.test(sql))
      throw new Error('A write inside a grant names its grant row.');
  }
  return g.unguarded(sql, params);
}

/** `EXISTS` over the statement's own grant row, for the tail of an unguarded write. */
export const grantRow = (g: Grant): { sql: string; params: SqlValue[] } => ({
  sql: 'EXISTS (SELECT 1 FROM authority_grants g WHERE g.id = ?)',
  params: [g.id],
});
