import type { z } from 'zod';
import type { ApiKeySchema } from '../../../shared/contracts/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { OrgRoleSchema } from '../../../shared/contracts/org-membership.ts';
import { API_SCOPES, type ApiScope } from '../../platform/auth.ts';
import { parseJsonArray } from '../../platform/json-column.ts';
import type * as repo from './repo.ts';

export type ApiKeyDto = z.infer<typeof ApiKeySchema>;
export const parseScopes = (raw: string): ApiScope[] =>
  parseJsonArray(raw, 'scopes', (s): s is ApiScope => API_SCOPES.includes(s as ApiScope));
export const parseRoles = (raw: string): OrgRole[] =>
  parseJsonArray(raw, 'roles', (r): r is OrgRole => OrgRoleSchema.options.includes(r as OrgRole));
export interface Resources {
  templateIds: string[];
  passStyles: ApiKeyDto['passStyles'];
}

export function toDto(
  row: repo.ApiKeyRow & { created_by_name?: string | null },
  resources: Resources = { templateIds: [], passStyles: [] },
  /** A key caller is not told which member made a key: no id, no name. */
  showCreator = true,
): ApiKeyDto {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    prefix: row.prefix,
    secretPrefix: `${row.secret_label}_${row.prefix}`,
    scopes: parseScopes(row.scopes),
    mode: row.mode,
    createdBy: showCreator ? row.created_by : null,
    createdByName: showCreator ? (row.created_by_name ?? null) : null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    kind: row.kind,
    roles: parseRoles(row.roles),
    retireAt: row.retire_at,
    ipAllow: row.ip_allow ? (JSON.parse(row.ip_allow) as string[]) : [],
    ...resources,
    rateTier: (row.rate_tier as ApiKeyDto['rateTier']) ?? null,
    parentKeyId: row.parent_key_id,
    rotatedFrom: row.rotated_from,
    origin: row.origin ?? 'app',
  };
}
