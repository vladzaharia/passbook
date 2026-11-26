import type { z } from 'zod';
import {
  auditScopeAllowed,
  TEMPLATE_ACT_AS_SCOPES,
  TEST_ONLY_SCOPES,
} from '../../../shared/contracts/api-keys.ts';
import type { CreateApiKeySchema } from '../../../shared/contracts/index.ts';
import { type ApiKeyKind, secretLabel } from '../../platform/api-key-token.ts';
import { CREDENTIAL_SCOPES, effectiveScopes } from '../../platform/api-scopes.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { ipListTooBroad, parseCidr } from '../../platform/ip-allow.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { AuditEntry } from '../audit/types.ts';
import { orgIsActive } from '../orgs/repo.ts';
import { orgIsDeveloper } from '../orgs/repo-entitlements.ts';
import { type ApiKeyAuthority, actorOf, authorityOrgId, delegableScopes } from './access.ts';
import { attenuate } from './attenuate.ts';
import { countOpenChildren, getKey, keyResources } from './repo.ts';
import { createKey } from './repo-create.ts';
import type { ApiKeyRow } from './repo-row.ts';
import { assertSandboxCeiling } from './sandbox-ceiling.ts';
import { type ApiKeyDto, parseRoles, parseScopes, type Resources, toDto } from './service-dto.ts';

/** A personal or platform key lives at most 90 days; a day of slack covers a client clock that runs ahead. */
export const MAX_LIFETIME_MS = 91 * 86_400_000;
/** Scopes a template or pass-style restriction can narrow: those whose routes name a template. */
/** Open (not revoked) child keys one key may hold. */
const MAX_CHILDREN = 50;
const RESTRICTABLE = /^(passes|nfc):|^templates:read$|^holders:write$/;

/** A fresh secret: shown once, stored only as its hash. */
export async function newSecret(ctx: ServiceContext, kind: ApiKeyKind, mode: 'live' | 'test') {
  const prefix = ctx.ids.token(6);
  const label = secretLabel(kind, mode);
  const secret = `${label}_${prefix}_${ctx.ids.token(32)}`;
  return { prefix, label, secret, hash: await sha256Hex(secret) };
}

/** A credential scope (`scanning:admin`, `nfc:keys`) mints PINs, pairing codes and tag keys: only a live key of one organization, and it expires within 90 days. Refused at mint, not at the first call. */
export function assertCredentialKey(
  scopes: readonly string[],
  kind: ApiKeyKind,
  mode: 'live' | 'test',
  expiresAt: number | null | undefined,
  now: number,
): void {
  if (!scopes.some((s) => (CREDENTIAL_SCOPES as readonly string[]).includes(s))) return;
  if (kind === 'platform' || mode !== 'live')
    throw new ValidationError(
      'Credential scopes (scanning:admin, nfc:keys, members:write) are for live keys of one organization.',
      [
        {
          path: 'scopes',
          message:
            'Credential scopes (scanning:admin, nfc:keys, members:write) are for live keys of one organization.',
        },
      ],
      'API_KEY_CREDENTIAL_LIVE_ORG',
    );
  if (expiresAt == null)
    throw new ValidationError(
      'A key with a credential scope needs an expiry.',
      [{ path: 'expiresAt', message: 'A key with a credential scope needs an expiry.' }],
      'API_KEY_EXPIRY_REQUIRED',
    );
  if (expiresAt > now + MAX_LIFETIME_MS)
    throw new ValidationError(
      'A key with a credential scope lives at most 90 days.',
      [{ path: 'expiresAt', message: 'A key with a credential scope lives at most 90 days.' }],
      'API_KEY_EXPIRY_TOO_LONG',
    );
}

/** Setup, template and audit scopes belong to one organization (a template scope acts as a member of it): a platform key never holds them. */
export function assertOrgBoundScopes(scopes: readonly string[], kind: ApiKeyKind): void {
  const orgOnly = ['org:write', 'wallet:write', 'audit:read', 'nfc:read', 'nfc:write'];
  if (
    kind === 'platform' &&
    scopes.some(
      (s) => orgOnly.includes(s) || (TEMPLATE_ACT_AS_SCOPES as readonly string[]).includes(s),
    )
  )
    throw invalid('These scopes are for keys of one organization.', 'API_KEY_ORG_SCOPE_ORG_ONLY');
}

/** Review and release work with Test keys only; a Live key never holds them, named or through a role. */
export function assertTestOnlyScopes(scopes: readonly string[], mode: 'live' | 'test'): void {
  const over = scopes.filter((s) => (TEST_ONLY_SCOPES as readonly string[]).includes(s));
  if (mode === 'live' && over.length)
    throw invalid(`${over.join(', ')} work with Test keys only.`, 'API_KEY_SCOPE_TEST_ONLY');
}

/** Reading the audit log shows Live and Test rows alike (the log has no mode), so only a Live key holds it, or a developer sandbox key (Test only). */
export async function assertAuditScope(
  db: D1Database,
  orgId: string | null,
  scopes: readonly string[],
  mode: 'live' | 'test',
): Promise<void> {
  if (!scopes.includes('audit:read') || mode === 'live') return;
  if (auditScopeAllowed(mode, orgId !== null && (await orgIsDeveloper(db, orgId)))) return;
  throw invalid('audit:read works with Live keys only.', 'API_KEY_SCOPE_LIVE_ONLY');
}

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
  if (authority.kind === 'api_key' && kind !== 'service') throw new ForbiddenError();
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
  // A list that allows (nearly) everyone is no allowlist: nothing wider than a v4 /8 or a v6 /32, in total.
  if (ipListTooBroad(ipAllow))
    throw invalid(
      'Allow narrower ranges: no wider than a /8 (IPv4) or /32 (IPv6), and not all addresses together.',
      'API_KEY_IP_TOO_BROAD',
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

/**
 * A key mints a child of itself: the parent row (read now, not the snapshot) must be a live service key that is
 * no child itself, and every dimension of the child is the parent's or narrower. The mode is the parent's: as for a
 * member, the one named in the body is not read. Returns the request with the
 * inherited settings filled in, so the same rules that check any key check the child.
 */
async function childInput(
  ctx: ServiceContext,
  authority: Extract<ApiKeyAuthority, { kind: 'api_key' }>,
  input: z.infer<typeof CreateApiKeySchema>,
): Promise<z.infer<typeof CreateApiKeySchema>> {
  const parent = await getKey(ctx.env.DB, authority.keyId, authority.orgId);
  if (
    !parent ||
    parent.revoked_at !== null ||
    parent.kind !== 'service' ||
    parent.mode !== authority.mode
  )
    throw new ForbiddenError();
  if (parent.parent_key_id !== null)
    throw new ForbiddenError('A child key cannot mint keys.', 'API_KEY_CHILD_CANNOT_MINT');
  // A key that is about to stop leaves no new family behind.
  if (parent.retire_at !== null)
    throw new ForbiddenError('A retiring key cannot mint keys.', 'API_KEY_PARENT_RETIRING');
  // Splitting into many keys is how a leaked parent hides: a parent holds a bounded family.
  if ((await countOpenChildren(ctx.env.DB, parent.id)) >= MAX_CHILDREN)
    throw invalid(
      `A key holds at most ${MAX_CHILDREN} open child keys. Revoke one first.`,
      'API_KEY_CHILD_LIMIT',
      'name',
    );
  const rows = await keyResources(ctx.env.DB, [parent.id]);
  const held: Resources = {
    templateIds: rows.filter((r) => r.kind === 'template').map((r) => r.value),
    passStyles: rows
      .filter((r) => r.kind === 'pass_style')
      .map((r) => r.value) as Resources['passStyles'],
  };
  const child = attenuate(parent, held, input);
  return { ...input, ...child, mode: parent.mode } as z.infer<typeof CreateApiKeySchema>;
}

export async function createApiKey(
  ctx: ServiceContext,
  authority: ApiKeyAuthority,
  raw: z.input<typeof CreateApiKeySchema>,
): Promise<ApiKeyDto & { secret: string }> {
  const given: z.infer<typeof CreateApiKeySchema> = {
    ...raw,
    scopes: raw.scopes ?? [],
    roles: raw.roles ?? [],
    mode: raw.mode ?? 'live',
  };
  const now = ctx.clock.now();
  const orgId = given.orgId;
  const kind = kindOf(authority, given);
  const needs = kind === 'personal' ? 'org:read' : 'integrations:manage';
  if (
    orgId !== authorityOrgId(authority) ||
    (authority.kind === 'session' && authority.capability !== needs)
  ) {
    throw new ForbiddenError();
  }
  const mode = authority.kind === 'platform' ? given.mode : authority.mode;
  const delegable = delegableScopes(authority);
  const asked = effectiveScopes(given.scopes, given.roles, mode);
  // A child holds a subset of its parent's scopes, whether named or through a role.
  if (authority.kind === 'api_key' && asked.some((scope) => !delegable.includes(scope)))
    throw new ForbiddenError(
      'A key cannot hold scopes beyond your own access.',
      'API_KEY_SCOPE_EXCEEDS_CREATOR',
    );
  const input = authority.kind === 'api_key' ? await childInput(ctx, authority, given) : given;
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
  // A sandbox holds the sandbox ceiling, whoever mints (a role's bundle counts too).
  await assertSandboxCeiling(ctx.env.DB, orgId, effectiveScopes(input.scopes, input.roles, mode));
  const held = effectiveScopes(input.scopes, input.roles, mode);
  assertTestOnlyScopes(input.scopes, mode);
  await assertAuditScope(ctx.env.DB, orgId, held, mode);
  assertCredentialKey(held, kind, mode, input.expiresAt, now);
  assertOrgBoundScopes(held, kind);
  const { prefix, label, secret, hash } = await newSecret(ctx, kind, mode);
  const row: ApiKeyRow = {
    id: ctx.ids.id(),
    org_id: orgId,
    name: input.name,
    prefix,
    key_hash: hash,
    // A role is a label: its bundle is written out here, so later changes to a bundle never reach this key.
    scopes: JSON.stringify(held),
    mode,
    created_by: authority.kind === 'api_key' ? null : authority.userId,
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
    parent_key_id: authority.kind === 'api_key' ? authority.keyId : null,
    rotated_from: null,
    created_by_key: authority.kind === 'api_key' ? authority.keyId : null,
    last_ip_prefix: null,
    created_amr: authority.kind === 'api_key' ? null : authority.amr,
  };
  const audit: AuditEntry = {
    orgId,
    ...actorOf(authority),
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
      ...(row.parent_key_id ? { parentKeyId: row.parent_key_id } : {}),
      ...(restricted ? { templateIds, passStyles } : {}),
    },
  };
  await createKey(ctx, row, authority, audit, { terminalIds, templateIds, passStyles });
  return { ...toDto(row, { templateIds, passStyles }), secret };
}
