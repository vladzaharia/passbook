import type { z } from 'zod';
import type {
  ApiKeyListQuerySchema,
  ApiKeySchema,
  CreateApiKeySchema,
} from '../../../shared/contracts/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { OrgRoleSchema } from '../../../shared/contracts/org-membership.ts';
import { type ApiKeyKind, apiKeyPrefixOf, secretLabel } from '../../platform/api-key-token.ts';
import { effectiveScopes, rolesCapableOf } from '../../platform/api-scopes.ts';
import type { ApiKeyStore } from '../../platform/auth.ts';
import { API_SCOPES, type ApiKeyAuth, type ApiScope } from '../../platform/auth.ts';
import { type Clock, systemClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import { ipPrefix } from '../../platform/ip.ts';
import { ipAllowed, parseCidr } from '../../platform/ip-allow.ts';
import { parseJsonArray } from '../../platform/json-column.ts';
import { enforceApiKeyRate, rememberApiTier } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { AuditEntry } from '../audit/types.ts';
import { orgIsActive } from '../orgs/repo.ts';
import { seesAccountEmails } from '../passes/account-email.ts';
import { type ApiKeyAuthority, authorityOrgId, delegableScopes } from './access.ts';
import * as repo from './repo.ts';

export type ApiKeyDto = z.infer<typeof ApiKeySchema>;
const parseScopes = (raw: string): ApiScope[] =>
  parseJsonArray(raw, 'scopes', (s): s is ApiScope => API_SCOPES.includes(s as ApiScope));
const parseRoles = (raw: string): OrgRole[] =>
  parseJsonArray(raw, 'roles', (r): r is OrgRole => OrgRoleSchema.options.includes(r as OrgRole));
const TOUCH_EVERY_MS = 5 * 60 * 1000;
/** A personal or platform key lives at most 90 days; a day of slack covers a client clock that runs ahead. */
const MAX_LIFETIME_MS = 91 * 86_400_000;
/** Scopes a template or pass-style restriction can narrow: those whose routes name a template. */
const RESTRICTABLE = /^(passes|templates|nfc):|^holders:write$/;

interface Resources {
  templateIds: string[];
  passStyles: ApiKeyDto['passStyles'];
}

function toDto(
  row: repo.ApiKeyRow & { created_by_name?: string | null },
  resources: Resources = { templateIds: [], passStyles: [] },
): ApiKeyDto {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    prefix: row.prefix,
    secretPrefix: `${row.secret_label}_${row.prefix}`,
    scopes: parseScopes(row.scopes),
    mode: row.mode,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? null,
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
  };
}

/** The key behind a bearer: its settings and use, never the secret or its hash. */
export async function describeOwnKey(ctx: ServiceContext, auth: ApiKeyAuth) {
  const row = await repo.getKey(ctx.env.DB, auth.keyId, auth.orgId);
  if (!row) return null;
  const { id, orgId, name, prefix, scopes, mode, createdAt, lastUsedAt, expiresAt } = toDto(row);
  const { kind, roles, retireAt } = toDto(row);
  return {
    id,
    orgId,
    name,
    prefix,
    scopes,
    mode,
    createdAt,
    lastUsedAt,
    expiresAt,
    kind,
    roles,
    retireAt,
  };
}

/** One page, plus how many revoked keys the same org filter holds. */
export async function listApiKeys(
  ctx: ServiceContext,
  query: z.infer<typeof ApiKeyListQuerySchema>,
  authority: ApiKeyAuthority,
): Promise<{ items: ApiKeyDto[]; nextCursor: string | null; revokedCount: number }> {
  const orgId = authorityOrgId(authority);
  const [rows, revokedCount] = await Promise.all([
    repo.listKeys(
      ctx.env.DB,
      { ...query, orgId, limit: query.limit + 1 },
      seesAccountEmails(authority),
    ),
    repo.countRevoked(ctx.env.DB, orgId),
  ]);
  const page = rows.slice(0, query.limit);
  const resources = await repo.keyResources(
    ctx.env.DB,
    page.filter((row) => row.restricted === 1).map((row) => row.id),
  );
  const of = (id: string): Resources => ({
    templateIds: resources
      .filter((r) => r.key_id === id && r.kind === 'template')
      .map((r) => r.value),
    passStyles: resources
      .filter((r) => r.key_id === id && r.kind === 'pass_style')
      .map((r) => r.value) as Resources['passStyles'],
  });
  return {
    items: page.map((row) => toDto(row, of(row.id))),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    revokedCount,
  };
}

const invalid = (message: string, code: string, path = 'scopes') =>
  new ValidationError(message, [{ path, message }], code);

/** What `kind` a request mints, and whether it fits the creator and the key's other settings. */
function kindOf(authority: ApiKeyAuthority, input: z.infer<typeof CreateApiKeySchema>): ApiKeyKind {
  const kind = input.kind ?? (input.orgId === null ? 'platform' : 'service');
  if ((kind === 'platform') !== (input.orgId === null))
    throw invalid(
      kind === 'platform' ? 'A platform key has no organization.' : 'Name an organization.',
      'API_KEY_KIND_INVALID',
      'kind',
    );
  if (kind === 'personal' && authority.kind !== 'session') throw new ForbiddenError();
  return kind;
}

/** Validates the settings that depend on the kind; returns the normalised allowlist. */
function checkKindRules(
  kind: ApiKeyKind,
  input: z.infer<typeof CreateApiKeySchema>,
  now: number,
): string[] {
  const ipAllow = [...new Set((input.ipAllow ?? []).map((c) => c.trim()))];
  if (ipAllow.some((c) => parseCidr(c) === null))
    throw invalid(
      'Use addresses or CIDR ranges, such as 203.0.113.0/24.',
      'API_KEY_IP_INVALID',
      'ipAllow',
    );
  if (input.scopes.length === 0 && input.roles.length === 0)
    throw invalid('Pick at least one scope or role.', 'API_KEY_SCOPES_REQUIRED');
  if (kind !== 'service') {
    const label = kind === 'personal' ? 'A personal key' : 'A platform key';
    if (input.expiresAt == null)
      throw invalid(`${label} needs an expiry.`, 'API_KEY_EXPIRY_REQUIRED', 'expiresAt');
    if (input.expiresAt > now + MAX_LIFETIME_MS)
      throw invalid(`${label} lives at most 90 days.`, 'API_KEY_EXPIRY_TOO_LONG', 'expiresAt');
  }
  if (kind === 'platform' && ipAllow.length === 0)
    throw invalid('A platform key needs an IP allowlist.', 'API_KEY_IP_REQUIRED', 'ipAllow');
  if (kind === 'platform' && input.roles.length > 0)
    throw invalid('A platform key holds scopes, not roles.', 'API_KEY_ROLES_ORG_ONLY', 'roles');
  if (kind === 'personal' && input.scopes.includes('scans:write'))
    throw invalid('A terminal key is not personal.', 'API_KEY_KIND_SCOPE');
  return ipAllow;
}

export async function createApiKey(
  ctx: ServiceContext,
  authority: ApiKeyAuthority,
  raw: z.input<typeof CreateApiKeySchema>,
): Promise<ApiKeyDto & { secret: string }> {
  const input: z.infer<typeof CreateApiKeySchema> = {
    ...raw,
    scopes: raw.scopes ?? [],
    roles: raw.roles ?? [],
    mode: raw.mode ?? 'live',
  };
  const now = ctx.clock.now();
  const orgId = input.orgId;
  const kind = kindOf(authority, input);
  const needs = kind === 'personal' ? 'org:read' : 'integrations:manage';
  if (
    orgId !== authorityOrgId(authority) ||
    (authority.kind === 'session' && authority.capability !== needs)
  ) {
    throw new ForbiddenError();
  }
  const scans = input.scopes.includes('scans:write');
  const terminalIds = [...new Set(input.terminalIds ?? [])];
  const templateIds = [...new Set(input.templateIds ?? [])];
  const passStyles = [...new Set(input.passStyles ?? [])];
  const restricted = templateIds.length + passStyles.length > 0;
  if (scans && orgId === null)
    throw new ValidationError('A platform key cannot scan.', [], 'API_KEY_SCAN_ORG_REQUIRED');
  const ipAllow = checkKindRules(kind, input, now);
  if (scans !== terminalIds.length > 0)
    throw new ValidationError(
      scans ? 'Pick at least one terminal.' : 'Terminals need the scan scope.',
      [{ path: 'terminalIds', message: scans ? 'Pick at least one terminal.' : 'Not needed.' }],
      scans ? 'API_KEY_TERMINALS_REQUIRED' : 'API_KEY_TERMINALS_UNUSED',
    );
  if (
    restricted &&
    (orgId === null || input.roles.length > 0 || input.scopes.some((s) => !RESTRICTABLE.test(s)))
  )
    throw new ValidationError(
      'Templates and styles narrow only the pass, holder, template and NFC scopes of an organization key.',
      [{ path: 'templateIds', message: 'Not supported with these scopes.' }],
      'API_KEY_RESTRICTION_UNSUPPORTED',
    );
  const delegable = delegableScopes(authority);
  if (input.scopes.some((scope) => !delegable.includes(scope))) {
    throw new ForbiddenError(
      'A key cannot hold scopes beyond your own access.',
      'API_KEY_SCOPE_EXCEEDS_CREATOR',
    );
  }
  if (input.expiresAt != null && input.expiresAt <= now) {
    throw new ValidationError('Expiry must be in the future.', [], 'EXPIRY_PAST');
  }
  if (orgId && !(await orgIsActive(ctx.env.DB, orgId))) {
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  }
  const mode = authority.kind === 'session' ? authority.mode : input.mode;
  const prefix = ctx.ids.token(6);
  const label = secretLabel(kind, mode);
  const secret = `${label}_${prefix}_${ctx.ids.token(32)}`;
  const row: repo.ApiKeyRow = {
    id: ctx.ids.id(),
    org_id: orgId,
    name: input.name,
    prefix,
    key_hash: await sha256Hex(secret),
    scopes: JSON.stringify([...new Set(input.scopes)]),
    mode,
    created_by: authority.userId,
    created_at: now,
    last_used_at: null,
    expires_at: input.expiresAt ?? null,
    revoked_at: null,
    kind,
    roles: JSON.stringify([...new Set(input.roles)]),
    membership_id:
      kind === 'personal' && authority.kind === 'session' ? authority.membershipId : null,
    retire_at: null,
    restricted: restricted ? 1 : 0,
    ip_allow: ipAllow.length ? JSON.stringify(ipAllow) : null,
    rate_tier: null,
    secret_label: label,
  };
  const audit: AuditEntry = {
    orgId,
    actorType: 'user',
    actorId: authority.userId,
    action: 'api_key.create',
    targetType: 'api_key',
    targetId: row.id,
    detail: {
      name: row.name,
      kind,
      scopes: parseScopes(row.scopes),
      mode: row.mode,
      expiresAt: row.expires_at,
      ...(row.roles === '[]' ? {} : { roles: parseRoles(row.roles) }),
      ...(ipAllow.length ? { ipAllow } : {}),
      ...(terminalIds.length ? { terminalIds } : {}),
      ...(restricted ? { templateIds, passStyles } : {}),
    },
  };
  await repo.createKey(ctx, row, authority, audit, { terminalIds, templateIds, passStyles });
  return { ...toDto(row, { templateIds, passStyles }), secret };
}

/** Whether `id` is a personal key of the member behind `authority`. */
export async function isOwnPersonalKey(
  ctx: ServiceContext,
  id: string,
  orgId: string | null,
  authority: ApiKeyAuthority,
): Promise<boolean> {
  if (authority.kind !== 'session') return false;
  const key = await repo.getKey(ctx.env.DB, id, orgId);
  return key?.kind === 'personal' && key.membership_id === authority.membershipId;
}

/** Idempotent: revoking a revoked key succeeds. */
export async function revokeApiKey(
  ctx: ServiceContext,
  authority: ApiKeyAuthority,
  id: string,
): Promise<void> {
  const key = await repo.getKey(ctx.env.DB, id, authorityOrgId(authority));
  if (!key) throw new NotFoundError('API key not found.', 'API_KEY_NOT_FOUND');
  await repo.revokeKey(ctx, id, authority, {
    orgId: key.org_id,
    actorType: 'user',
    actorId: authority.userId,
    action: 'api_key.revoke',
    targetType: 'api_key',
    targetId: id,
  });
}

/** Ends a key at an instant before it would otherwise end. Once only: a second call is a conflict. */
export async function retireApiKey(
  ctx: ServiceContext,
  authority: ApiKeyAuthority,
  id: string,
  retireAt: number,
): Promise<void> {
  const key = await repo.getKey(ctx.env.DB, id, authorityOrgId(authority));
  if (!key) throw new NotFoundError('API key not found.', 'API_KEY_NOT_FOUND');
  if (retireAt <= ctx.clock.now())
    throw invalid('Retirement must be in the future.', 'RETIRE_PAST', 'retireAt');
  if (key.expires_at !== null && retireAt > key.expires_at)
    throw invalid('Retirement cannot be after expiry.', 'RETIRE_AFTER_EXPIRY', 'retireAt');
  if (key.revoked_at !== null || key.retire_at !== null)
    throw new ConflictError('The key is already revoked or retiring.', 'API_KEY_RETIRE_SET');
  await repo.retireKey(ctx, id, retireAt, authority, {
    orgId: key.org_id,
    actorType: 'user',
    actorId: authority.userId,
    action: 'api_key.retire',
    targetType: 'api_key',
    targetId: id,
    detail: { retireAt },
  });
}

/** Resolves a presented key. Null for anything invalid; throws 429 when the key is over its limit. */
export function createApiKeyStore(env: AppEnv, clock: Clock = systemClock): ApiKeyStore {
  return {
    async resolve(rawKey, caller): Promise<ApiKeyAuth | null> {
      const prefix = apiKeyPrefixOf(rawKey);
      if (!prefix) return null;
      const row = await repo.findByPrefix(env.DB, prefix);
      if (!row || !(await safeEqual(await sha256Hex(rawKey), row.key_hash))) return null;
      const now = clock.now();
      if (
        row.revoked_at !== null ||
        (row.expires_at !== null && row.expires_at <= now) ||
        (row.retire_at !== null && row.retire_at <= now)
      )
        return null;
      if (row.org_id !== null && row.org_status !== 'active') return null;
      // A personal key dies with its membership or user; its reach is capped by the member's roles now.
      if (row.kind === 'personal' && row.member_roles === null) return null;
      // The caller's address is not an oracle: a wrong address looks like a wrong key. No address means no match.
      const allow = row.ip_allow ? (JSON.parse(row.ip_allow) as string[]) : [];
      if (allow.length > 0 && !ipAllowed(caller?.ip, allow)) return null;
      if (row.restricted === 1)
        throw new ForbiddenError(
          'A key limited to templates cannot be used yet.',
          'API_KEY_RESTRICTION_PENDING',
        );
      const tier = await enforceApiKeyRate(
        env,
        { keyId: row.id, orgId: row.org_id },
        row.rate_tier,
      );
      await repo.touchKey(env.DB, row.id, now, TOUCH_EVERY_MS, ipPrefix(caller?.ip));
      const held = effectiveScopes(parseScopes(row.scopes), parseRoles(row.roles));
      const memberRoles = row.member_roles ? parseRoles(row.member_roles) : null;
      const auth: ApiKeyAuth = {
        kind: 'api_key',
        keyId: row.id,
        orgId: row.org_id,
        scopes: memberRoles
          ? held.filter((s) => rolesCapableOf(s).some((role) => memberRoles.includes(role)))
          : held,
        mode: row.mode,
      };
      rememberApiTier(auth, tier);
      return auth;
    },
  };
}
