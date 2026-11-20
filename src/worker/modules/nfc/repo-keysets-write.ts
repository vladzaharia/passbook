import { type Grant, grant } from '../../platform/authority.ts';
import { type Check, exactlyOne, rowIs } from '../../platform/authority-checks.ts';
import { exists, type GrantCond } from '../../platform/authority-cond.ts';
import { ne } from '../../platform/authority-expr.ts';
import type { Envelope } from '../../platform/crypto.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';

type Session = Extract<TenantPassWrite, { kind: 'session' }>;
/** A keyset change is a console action: the captured session holds scanning:manage. */
export type KeysetAuthority = Session & { capability: 'scanning:manage' };

export type KeysetPurpose = `org_mode.nfc.keyset.${'create' | 'rotate' | 'retire_key' | 'disable'}`;

function keysetGrant(
  ctx: ServiceContext,
  purpose: KeysetPurpose,
  a: KeysetAuthority,
  checks: Check[],
): Grant {
  return grant(ctx, {
    purpose,
    principal: tenantPrincipal(a),
    checks: [...capabilityChecks(a), ...checks],
    codes: { lineage: 'KEYSET_CHANGED', stale: 'KEYSET_CHANGED' },
    tables: ['nfc_tag_keysets', 'nfc_tag_keys'],
  });
}

interface Audit {
  ctx: ServiceContext;
  a: KeysetAuthority;
  keysetId: string;
  action: string;
  detail: Record<string, unknown>;
}
/** Details name versions and counts, never keys. */
const audited = (g: Grant, { ctx, a, keysetId, action, detail }: Audit, ...when: GrantCond[]) =>
  grantedAudit(
    g,
    ctx,
    {
      orgId: a.orgId,
      actorType: 'user',
      actorId: a.userId,
      action,
      targetType: 'tag_keyset',
      targetId: keysetId,
      detail,
    },
    when,
  );

/** A version as it is inserted: its row id (the AAD id), number and sealed keys. */
export interface NewVersion {
  id: string;
  version: number;
  envelope: Envelope;
}

export interface NewKeyset {
  id: string;
  name: string;
  slug: string;
  diversify: boolean;
  first: NewVersion;
}

const VERSION_COLUMNS = [
  'id',
  'version',
  'kek_version',
  'iv',
  'wrapped_dek',
  'ciphertext',
  'state',
  'created_at',
];
const versionValues = (v: NewVersion, now: number) => [
  v.id,
  v.version,
  v.envelope.kekVersion,
  v.envelope.iv,
  v.envelope.wrappedDek,
  v.envelope.ciphertext,
  'active',
  now,
];

/** The keyset and its version 1 in one batch. */
export function createKeysetGrant(ctx: ServiceContext, a: KeysetAuthority, k: NewKeyset): Grant {
  const now = ctx.clock.now();
  const g = keysetGrant(ctx, 'org_mode.nfc.keyset.create', a, []);
  g.insertSelect(
    'nfc_tag_keysets',
    ['id', 'name', 'slug', 'diversify', 'created_at', 'created_by'],
    [k.id, k.name, k.slug, k.diversify ? 1 : 0, now, a.userId],
  );
  g.insertJoined('nfc_tag_keys', {
    parents: { keyset_id: k.id },
    columns: VERSION_COLUMNS,
    values: versionValues(k.first, now),
  });
  audited(
    g,
    {
      ctx,
      a,
      keysetId: k.id,
      action: 'tag_keyset.create',
      detail: { mode: a.mode, diversify: k.diversify },
    },
    exists('nfc_tag_keys', { keyset_id: k.id, version: 1 }),
  );
  return g;
}

/** The active version becomes retiring and the next one is active. Refused if the keyset changed meanwhile. */
export function rotateKeysetGrant(
  ctx: ServiceContext,
  a: KeysetAuthority,
  keysetId: string,
  from: number,
  next: NewVersion,
): Grant {
  const now = ctx.clock.now();
  const g = keysetGrant(ctx, 'org_mode.nfc.keyset.rotate', a, [
    rowIs('nfc_tag_keysets', keysetId, { disabled_at: null }),
    exactlyOne(
      'nfc_tag_keys',
      { keyset_id: keysetId, version: from, state: 'active' },
      'keyset_id',
    ),
  ]);
  g.joined('nfc_tag_keys', {
    via: 'keyset_id',
    where: { keyset_id: keysetId, version: from, state: 'active' },
    set: { state: 'retiring', state_at: now },
    require: 'one',
    returning: ['version'],
  });
  g.insertJoined('nfc_tag_keys', {
    parents: { keyset_id: keysetId },
    columns: VERSION_COLUMNS,
    values: versionValues(next, now),
  });
  audited(
    g,
    { ctx, a, keysetId, action: 'tag_keyset.rotate', detail: { from, to: next.version } },
    exists('nfc_tag_keys', { keyset_id: keysetId, version: next.version, state: 'active' }),
  );
  return g;
}

/** A retiring version is retired: it no longer verifies. */
export function retireKeyGrant(
  ctx: ServiceContext,
  a: KeysetAuthority,
  keysetId: string,
  version: number,
): Grant {
  const g = keysetGrant(ctx, 'org_mode.nfc.keyset.retire_key', a, [
    exactlyOne('nfc_tag_keys', { keyset_id: keysetId, version, state: 'retiring' }, 'keyset_id'),
  ]);
  g.joined('nfc_tag_keys', {
    via: 'keyset_id',
    where: { keyset_id: keysetId, version, state: 'retiring' },
    set: { state: 'retired', state_at: ctx.clock.now() },
    require: 'one',
    returning: ['version'],
  });
  audited(
    g,
    { ctx, a, keysetId, action: 'tag_keyset.retire_key', detail: { version } },
    exists('nfc_tag_keys', { keyset_id: keysetId, version, state: 'retired' }),
  );
  return g;
}

/** The keyset stops verifying, for good, and every key it holds is retired. */
export function disableKeysetGrant(
  ctx: ServiceContext,
  a: KeysetAuthority,
  keysetId: string,
): Grant {
  const now = ctx.clock.now();
  const g = keysetGrant(ctx, 'org_mode.nfc.keyset.disable', a, [
    rowIs('nfc_tag_keysets', keysetId, { disabled_at: null }),
  ]);
  g.update('nfc_tag_keysets', {
    set: { disabled_at: now },
    where: { id: keysetId, disabled_at: null },
    require: 'one',
  });
  g.joined('nfc_tag_keys', {
    via: 'keyset_id',
    where: { keyset_id: keysetId, state: ne('retired') },
    set: { state: 'retired', state_at: now },
  });
  audited(
    g,
    { ctx, a, keysetId, action: 'tag_keyset.disable', detail: {} },
    exists('nfc_tag_keysets', { id: keysetId, disabled_at: now }),
  );
  return g;
}
