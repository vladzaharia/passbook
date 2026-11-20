import type { Mode } from '../../../shared/contracts/common.ts';
import { type Grant, grant } from '../../platform/authority.ts';
import { type Check, exactlyOne, rowIs } from '../../platform/authority-checks.ts';
import { exists, type GrantCond } from '../../platform/authority-cond.ts';
import { ne } from '../../platform/authority-expr.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';

type Session = Extract<TenantPassWrite, { kind: 'session' }>;
/** A keyset change is a console action: the captured session holds scanning:manage. */
export type KeysetAuthority = Session & { capability: 'scanning:manage' };

export type KeyState = 'active' | 'retiring' | 'retired';

export interface KeysetRow {
  id: string;
  orgId: string;
  mode: Mode;
  name: string;
  slug: string;
  diversify: boolean;
  createdAt: number;
  disabledAt: number | null;
}

export interface KeyRow {
  version: number;
  state: KeyState;
  createdAt: number;
  stateAt: number | null;
  /** Tags whose last read used this version. */
  tags: number;
}

interface RawKeyset {
  id: string;
  org_id: string;
  mode: Mode;
  name: string;
  slug: string;
  diversify: number;
  created_at: number;
  disabled_at: number | null;
}

const KEYSET = 'id, org_id, mode, name, slug, diversify, created_at, disabled_at';
const keysetOf = (r: RawKeyset): KeysetRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  name: r.name,
  slug: r.slug,
  diversify: r.diversify === 1,
  createdAt: r.created_at,
  disabledAt: r.disabled_at,
});

export async function keysetById(db: D1Database, id: string): Promise<KeysetRow | null> {
  const row = await first<RawKeyset>(db, `SELECT ${KEYSET} FROM nfc_tag_keysets WHERE id = ?`, [
    id,
  ]);
  return row && keysetOf(row);
}

/** Newest first (ids are UUIDv7). */
export async function keysetsOf(db: D1Database, orgId: string, mode: Mode): Promise<KeysetRow[]> {
  const rows = await all<RawKeyset>(
    db,
    `SELECT ${KEYSET} FROM nfc_tag_keysets WHERE org_id = ? AND mode = ? ORDER BY id DESC`,
    [orgId, mode],
  );
  return rows.map(keysetOf);
}

export const liveKeysetCount = async (db: D1Database, orgId: string, mode: Mode) =>
  (
    await first<{ n: number }>(
      db,
      'SELECT count(*) AS n FROM nfc_tag_keysets WHERE org_id = ? AND mode = ? AND disabled_at IS NULL',
      [orgId, mode],
    )
  )?.n ?? 0;

/** Versions of the given keysets, oldest first, with the tags on each. Never selects key material. */
export async function keyVersionsOf(
  db: D1Database,
  keysetIds: string[],
): Promise<Map<string, KeyRow[]>> {
  const out = new Map<string, KeyRow[]>();
  if (keysetIds.length === 0) return out;
  const rows = await all<{
    keyset_id: string;
    version: number;
    state: KeyState;
    created_at: number;
    state_at: number | null;
    tags: number;
  }>(
    db,
    `SELECT k.keyset_id, k.version, k.state, k.created_at, k.state_at,
        (SELECT count(*) FROM nfc_tag_sun s WHERE s.keyset_id = k.keyset_id AND s.key_version = k.version) AS tags
      FROM nfc_tag_keys k WHERE k.keyset_id IN (${keysetIds.map(() => '?').join(', ')})
      ORDER BY k.keyset_id, k.version`,
    keysetIds,
  );
  for (const r of rows) {
    const list = out.get(r.keyset_id) ?? [];
    list.push({
      version: r.version,
      state: r.state,
      createdAt: r.created_at,
      stateAt: r.state_at,
      tags: r.tags,
    });
    out.set(r.keyset_id, list);
  }
  return out;
}

/** The sealed material of one version. For the verifier (S3) and rotation; no route reads it. */
export const sealedKeys = (db: D1Database, keysetId: string, version: number) =>
  first<{ metaKey: string; fileKey: string; state: KeyState }>(
    db,
    'SELECT meta_key AS metaKey, file_key AS fileKey, state FROM nfc_tag_keys WHERE keyset_id = ? AND version = ?',
    [keysetId, version],
  );

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

export interface NewKeyset {
  id: string;
  name: string;
  slug: string;
  diversify: boolean;
  metaKey: string;
  fileKey: string;
}

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
    columns: ['version', 'meta_key', 'file_key', 'state', 'created_at'],
    values: [1, k.metaKey, k.fileKey, 'active', now],
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
  next: { version: number; metaKey: string; fileKey: string },
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
    columns: ['version', 'meta_key', 'file_key', 'state', 'created_at'],
    values: [next.version, next.metaKey, next.fileKey, 'active', now],
  });
  audited(
    g,
    { ctx, a, keysetId, action: 'tag_keyset.rotate', detail: { from, to: next.version } },
    exists('nfc_tag_keys', { keyset_id: keysetId, version: next.version, state: 'active' }),
  );
  return g;
}

/** A retiring version is retired and its key material is overwritten with ''. */
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
    set: { state: 'retired', state_at: ctx.clock.now(), meta_key: '', file_key: '' },
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

/** The keyset stops verifying, for good, and every key it holds is retired and wiped. */
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
    set: { state: 'retired', state_at: now, meta_key: '', file_key: '' },
  });
  audited(
    g,
    { ctx, a, keysetId, action: 'tag_keyset.disable', detail: {} },
    exists('nfc_tag_keysets', { id: keysetId, disabled_at: now }),
  );
  return g;
}
