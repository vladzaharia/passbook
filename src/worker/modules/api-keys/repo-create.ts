import { TEST_ONLY_SCOPES } from '../../../shared/contracts/api-keys.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import {
  ROLE_PRESETS,
  rolesCapableOf,
  scopeCapability,
  type TenantScope,
} from '../../platform/api-scopes.ts';
import { grant } from '../../platform/authority.ts';
import { type Check, exactlyOne, rowIs } from '../../platform/authority-checks.ts';
import { withinLimit } from '../../platform/entitlements.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { AuditEntry } from '../audit/types.ts';
import {
  capabilityChecks,
  membershipCapability,
  tenantPrincipal,
} from '../passes/repo-authority.ts';
import { type ApiKeyAuthority, delegableScopes } from './access.ts';
import { endChildren } from './repo.ts';
import type { ApiKeyRow, KeyExtras, Replaces } from './repo-row.ts';

const PLATFORM_KEY_TENANT = ['org_id', 'mode'];
const OPEN = { revoked_at: null, retire_at: null };

/**
 * The key a rotation replaces, as the new row copies it: open, with the parent the caller claims, and the same
 * scopes, roles, kind, addresses, expiry and limit, so a rotation cannot swap in another key's secret or reach.
 */
function replacedKey(key: ApiKeyRow, replaces: Replaces): Check {
  return rowIs('api_keys', replaces.id, {
    ...OPEN,
    parent_key_id: replaces.parent,
    scopes: key.scopes,
    roles: key.roles,
    kind: key.kind,
    ip_allow: key.ip_allow,
    expires_at: key.expires_at,
    restricted: key.restricted,
    // A personal key is rotated by its member only.
    ...(key.kind === 'personal' ? { membership_id: key.membership_id } : {}),
  });
}

/** The old key ends at `retireAt`, in the same batch as the new one; the batch fails if it was no longer open. */
function retireOld(g: ReturnType<typeof grant>, replaces: Replaces) {
  g.update('api_keys', {
    set: { retire_at: replaces.retireAt },
    where: { id: replaces.id, ...OPEN },
    require: 'one',
  });
  endChildren(g, replaces.id, replaces.retireAt);
}

/**
 * Mints a key under a grant: `org_mode.api_key.create` for an org-bound key (the creator's live membership
 * and session, `integrations:manage`, in the request's mode) or `platform.api_key.create` for a null-org key (a live admin
 * session). A key cannot hold scopes beyond its creator's roles: `delegableScopes` is derived from the
 * membership's roles, which are immutable, and re-checked here so the repo stands alone.
 */
export async function createKey(
  ctx: ServiceContext,
  key: ApiKeyRow,
  authority: ApiKeyAuthority,
  audit: AuditEntry,
  extras: Partial<KeyExtras> = {},
): Promise<void> {
  const { terminalIds = [], templateIds = [], passStyles = [], replaces } = extras;
  const rotating = replaces !== undefined;
  // The grant supplies org_id and mode of a tenant key: the creator's org and request mode.
  const columns = [
    'name',
    'prefix',
    'key_hash',
    'scopes',
    'created_by',
    'created_at',
    'expires_at',
    'kind',
    'roles',
    'membership_id',
    'restricted',
    'ip_allow',
    'secret_label',
    'parent_key_id',
    'rotated_from',
    'created_by_key',
    'rate_tier',
    'created_amr',
  ];
  const values = [
    key.name,
    key.prefix,
    key.key_hash,
    key.scopes,
    key.created_by,
    key.created_at,
    key.expires_at,
    key.kind,
    key.roles,
    key.membership_id,
    key.restricted,
    key.ip_allow,
    key.secret_label,
    key.parent_key_id,
    key.rotated_from,
    key.created_by_key,
    // A tier a platform admin set follows the key through rotation; a new key has none.
    rotating ? key.rate_tier : null,
    key.created_amr,
  ];
  if (authority.kind === 'platform') {
    if (
      key.org_id !== null ||
      key.kind !== 'platform' ||
      terminalIds.length > 0 ||
      key.created_by_key !== null ||
      (rotating && key.rotated_from !== replaces.id)
    )
      throw new ForbiddenError();
    const g = grant(ctx, {
      purpose: rotating ? 'platform.api_key.rotate' : 'platform.api_key.create',
      principal: { kind: 'platform', userId: authority.userId, sessionIdHash: authority.sessionId },
      target: key.id,
      ...(rotating ? { checks: [replacedKey(key, replaces)] } : {}),
    });
    // A platform grant injects no tenant: a platform key names its own (null) org and mode.
    const platformColumns = ['id', ...PLATFORM_KEY_TENANT, ...columns];
    const platformValues = [key.id, null, key.mode, ...values];
    g.insertSelect('api_keys', platformColumns, platformValues);
    g.add(grantedAudit(g, ctx, audit));
    if (rotating) retireOld(g, replaces);
    await g.commit();
    return;
  }
  const explicit = JSON.parse(key.scopes) as TenantScope[];
  const roles = JSON.parse(key.roles) as OrgRole[];
  const delegable: string[] = delegableScopes(authority);
  // A rotation checks the stored scopes (a role's bundle was written into them at mint), never the bundle as it stands now.
  const presets = rotating
    ? []
    : roles
        .flatMap((role) => ROLE_PRESETS[role])
        .filter(
          (scope) =>
            key.mode === 'test' || !(TEST_ONLY_SCOPES as readonly string[]).includes(scope),
        );
  const personal = key.kind === 'personal';
  const byKey = authority.kind === 'api_key';
  // A role preset is held in full or not at all: each of its scopes must be within the creator's roles.
  // A key's stored scopes already include its roles' presets, and a child holds at most its parent's.
  const beyond = byKey
    ? explicit.some(
        (scope) => !(rotating && replaces.self ? authority.scopes : delegable).includes(scope),
      )
    : explicit.some((scope) => !delegable.includes(scope)) ||
      presets.some(
        (scope) => !rolesCapableOf(scope).some((role) => authority.roles.includes(role)),
      );
  if (
    (!byKey && authority.capability !== (personal ? 'org:read' : 'integrations:manage')) ||
    key.org_id !== authority.orgId ||
    (personal && (byKey || key.membership_id !== authority.membershipId)) ||
    (byKey &&
      (key.kind !== 'service' ||
        key.parent_key_id !== (rotating ? replaces.parent : authority.keyId))) ||
    // What made the row, and what it replaces, are the caller's own: a key rotates itself or its children only.
    key.created_by_key !== (byKey ? authority.keyId : null) ||
    (rotating &&
      (key.rotated_from !== replaces.id ||
        (byKey &&
          (replaces.self !== (replaces.id === authority.keyId) ||
            (!replaces.self && replaces.parent !== authority.keyId))))) ||
    beyond
  )
    throw new ForbiddenError(
      'A key cannot hold scopes beyond your own access.',
      'API_KEY_SCOPE_EXCEEDS_CREATOR',
    );
  if (key.mode !== authority.mode) throw new ForbiddenError();
  // The creator's own stored roles must grant each capability, not the snapshot's `roles`.
  const capabilities = new Set([...explicit, ...presets].map((scope) => scopeCapability[scope]));
  const g = grant(ctx, {
    purpose: rotating ? 'org_mode.api_key.rotate' : 'org_mode.api_key.create',
    principal: tenantPrincipal(authority),
    target: key.id,
    checks: [
      ...capabilityChecks(authority),
      // Revoked, expired and retired keys free their slot; a rotation replaces a key, so it does not take one.
      ...(rotating
        ? []
        : [
            withinLimit(
              'api.keys',
              `SELECT COUNT(*) FROM api_keys k WHERE k.org_id = {org} AND k.revoked_at IS NULL
                AND (k.expires_at IS NULL OR k.expires_at > ?)
                AND (k.retire_at IS NULL OR k.retire_at > ?)`,
              [key.created_at, key.created_at],
            ),
          ]),
      ...(authority.kind === 'session'
        ? [...capabilities].map((capability) =>
            membershipCapability(authority.membershipId, capability),
          )
        : []),
      // A key mints children of itself, never when it is a child; a rotation reads the key it replaces.
      ...(byKey && !rotating
        ? [
            rowIs(
              'api_keys',
              authority.keyId,
              { parent_key_id: null, kind: 'service', retire_at: null },
              'actor',
            ),
          ]
        : []),
      ...(rotating ? [replacedKey(key, replaces)] : []),
      // A terminal of the grant's org and mode, still in service; the binding is written with the key.
      ...terminalIds.map((id) =>
        exactlyOne('scanners', { id, kind: 'terminal', revoked_at: null }),
      ),
      // A restricted key names templates of its own org.
      ...templateIds.map((id) => exactlyOne('templates', { id })),
    ],
    codes: {
      lineage: rotating
        ? 'API_KEY_NOT_FOUND'
        : terminalIds.length
          ? 'API_KEY_TERMINAL_UNKNOWN'
          : 'API_KEY_TEMPLATE_UNKNOWN',
    },
  });
  g.insertSelect('api_keys', ['id', ...columns], [key.id, ...values]);
  for (const scannerId of terminalIds)
    g.insertJoined('api_key_terminals', {
      parents: { key_id: key.id, scanner_id: scannerId },
      columns: [],
      values: [],
    });
  for (const [kind, value] of [
    ...templateIds.map((id) => ['template', id] as const),
    ...passStyles.map((style) => ['pass_style', style] as const),
  ])
    g.insertJoined('api_key_resources', {
      parents: { key_id: key.id },
      columns: ['kind', 'value'],
      values: [kind, value],
    });
  g.add(grantedAudit(g, ctx, audit));
  if (rotating) retireOld(g, replaces);
  await g.commit();
}
