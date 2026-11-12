import { first, type SqlValue } from '../../platform/db.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import type { TemplateAuthority } from './access.ts';
import type { CommitArgs } from './persist.ts';
import { templateAuthorityPredicate } from './repo-authority.ts';

type TemplateSource = NonNullable<CommitArgs['source']>;

export function templateSourcePredicate(
  source: TemplateSource,
  now: number,
): { sql: string; params: SqlValue[] } {
  const authority = source.authority;
  if (
    source.orgId === null
      ? authority !== undefined
      : authority?.kind !== 'session' ||
        authority.capability !== 'templates:read' ||
        authority.orgId !== source.orgId
  ) {
    return { sql: '0', params: [] };
  }
  const readAuthority =
    authority?.kind === 'session'
      ? {
          sql: `AND source_template.org_id = ? AND (${tenantPassAuthoritySql(authority)})`,
          params: [authority.orgId, ...tenantPassAuthorityParams(authority, now)],
        }
      : { sql: '', params: [] };
  return {
    sql: `EXISTS (
      SELECT 1 FROM templates source_template
      JOIN template_versions source_version ON source_version.template_id = source_template.id
      WHERE source_template.id = ? AND source_template.org_id IS ?
        AND source_template.status != 'deleted' AND source_version.version = ?
        ${readAuthority.sql}
    )`,
    params: [source.id, source.orgId, source.version, ...readAuthority.params],
  };
}

export async function hasTemplateSource(
  db: D1Database,
  source: TemplateSource,
  now: number,
): Promise<boolean> {
  const guard = templateSourcePredicate(source, now);
  const allowed = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok WHERE ${guard.sql}`,
    guard.params,
  );
  return !!allowed;
}

export async function hasCloneAuthority(
  db: D1Database,
  authority: TemplateAuthority,
  orgId: string,
  source: TemplateSource,
  now: number,
): Promise<boolean> {
  const destination = templateAuthorityPredicate(authority, '?', now);
  const sourceGuard = templateSourcePredicate(source, now);
  const allowed = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok WHERE (${destination.sql}) AND (${sourceGuard.sql})`,
    [orgId, ...destination.params, ...sourceGuard.params],
  );
  return !!allowed;
}
