import type { TenantPassWrite } from './http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from './repo-authority.ts';

export function permitsPassMutation(authority?: TenantPassWrite): boolean {
  return (
    !authority ||
    (authority.kind === 'session'
      ? authority.capability === 'passes:operate'
      : authority.scope === 'passes:write')
  );
}

/** Bind the reviewed mode as well as the target pass's organization. */
export function tenantPassWriteSql(authority: TenantPassWrite): string {
  return `${tenantPassAuthoritySql(authority, 'passes')} AND passes.mode = ?`;
}

export function tenantPassWriteParams(authority: TenantPassWrite, now: number) {
  return [...tenantPassAuthorityParams(authority, now), authority.mode];
}
