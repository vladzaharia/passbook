import type { z } from 'zod';
import type { CreateApiKeySchema } from '../../../shared/contracts/index.ts';
import { type ApiKeyKind, secretLabel } from '../../platform/api-key-token.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { parseCidr } from '../../platform/ip-allow.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { AuditEntry } from '../audit/types.ts';
import { orgIsActive } from '../orgs/repo.ts';
import { type ApiKeyAuthority, authorityOrgId, delegableScopes } from './access.ts';
import { createKey } from './repo-create.ts';
import type { ApiKeyRow } from './repo-row.ts';
import { type ApiKeyDto, parseRoles, parseScopes, toDto } from './service-dto.ts';

/** A personal or platform key lives at most 90 days; a day of slack covers a client clock that runs ahead. */
const MAX_LIFETIME_MS = 91 * 86_400_000;
/** Scopes a template or pass-style restriction can narrow: those whose routes name a template. */
const RESTRICTABLE = /^(passes|templates|nfc):|^holders:write$/;

export const invalid = (message: string, code: string, path = 'scopes') =>
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
  // A range of every address is no allowlist.
  if (ipAllow.some((c) => (parseCidr(c)?.bits ?? 0) === 0))
    throw invalid(
      'Use addresses or CIDR ranges, such as 203.0.113.0/24, not 0.0.0.0/0.',
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
  const row: ApiKeyRow = {
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
  await createKey(ctx, row, authority, audit, { terminalIds, templateIds, passStyles });
  return { ...toDto(row, { templateIds, passStyles }), secret };
}
