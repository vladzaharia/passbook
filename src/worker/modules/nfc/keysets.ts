import type { z } from 'zod';
import type {
  RotateTagKeysetSchema,
  TagKeysetViewSchema,
} from '../../../shared/contracts/nfc-tag-keysets.ts';
import type { CreateTagKeysetSchema } from '../../../shared/contracts/nfc-tags.ts';
import { loadKekRing } from '../../platform/crypto.ts';
import { classifyD1Error } from '../../platform/db.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import { randomBytes } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { KEY_BYTES, type KeyScope, openVersion, sealVersion } from './keyset-seal.ts';
import {
  type KeyRow,
  type KeysetRow,
  keysetById,
  keysetsOf,
  keyVersionsOf,
  liveKeysetCount,
  orgVersionEnvelopes,
  versionEnvelopes,
} from './repo-keysets.ts';
import {
  createKeysetGrant,
  disableKeysetGrant,
  type KeysetAuthority,
  retireKeyGrant,
  rotateKeysetGrant,
} from './repo-keysets-write.ts';
import { bytesToHex, constantTimeEqual, hexToBytes } from './sun.ts';

/** Live (not disabled) keysets per org and mode. */
export const KEYSETS_PER_ORG_MODE = 4;
const MAX_VERSION = 255;
const SLUG_TRIES = 3;
const SLUG_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export type KeysetView = z.infer<typeof TagKeysetViewSchema>;
type Keys = { metaKey: string; fileKey: string };
export type MadeKeyset = KeysetView & { keys: Keys | null };

/** The captured console session holds scanning:manage for this org. */
export function keysetAuthorityOf(authority: TenantPassWrite): KeysetAuthority {
  if (authority.kind !== 'session' || authority.capability !== 'scanning:manage')
    throw new ForbiddenError();
  return { ...authority, capability: 'scanning:manage' };
}

const notFound = () => new NotFoundError('Keyset not found.', 'KEYSET_NOT_FOUND');
const conflict = (message: string, code: string) => new ConflictError(message, code);

const viewOf = (k: KeysetRow, versions: KeyRow[]): KeysetView => ({
  id: k.id,
  name: k.name,
  slug: k.slug,
  diversify: k.diversify,
  createdAt: k.createdAt,
  disabledAt: k.disabledAt,
  versions,
});

export async function listKeysets(ctx: ServiceContext, orgId: string, mode: KeysetRow['mode']) {
  const rows = await keysetsOf(ctx.env.DB, orgId, mode);
  const versions = await keyVersionsOf(
    ctx.env.DB,
    rows.map((r) => r.id),
  );
  return rows.map((r) => viewOf(r, versions.get(r.id) ?? []));
}

/** A keyset of the caller's org and mode; anything else is the same 404. */
async function keysetIn(ctx: ServiceContext, a: KeysetAuthority, id: string): Promise<KeysetRow> {
  const row = await keysetById(ctx.env.DB, id);
  if (!row || row.orgId !== a.orgId || row.mode !== a.mode) throw notFound();
  return row;
}

export async function keysetView(ctx: ServiceContext, a: KeysetAuthority, id: string) {
  const row = await keysetIn(ctx, a, id);
  return viewOf(row, (await keyVersionsOf(ctx.env.DB, [id])).get(id) ?? []);
}

/** Keys the caller entered or the server generates. A factory-default (all zero) key or one key for both roles is refused. */
function pickKeys(input: { generate: true } | { metaKey: string; fileKey: string }): {
  meta: Uint8Array;
  file: Uint8Array;
  shown: Keys | null;
} {
  if ('generate' in input) {
    const meta = randomBytes(KEY_BYTES);
    const file = randomBytes(KEY_BYTES);
    return { meta, file, shown: { metaKey: bytesToHex(meta), fileKey: bytesToHex(file) } };
  }
  const meta = hexToBytes(input.metaKey);
  const file = hexToBytes(input.fileKey);
  if (meta?.length !== KEY_BYTES || file?.length !== KEY_BYTES)
    throw new ValidationError('A key is 32 hex digits.', [], 'KEYSET_KEY_INVALID');
  if (!meta.some(Boolean) || !file.some(Boolean) || bytesToHex(meta) === bytesToHex(file))
    throw new ValidationError(
      'Use two different keys, and not the factory default.',
      [],
      'KEYSET_KEY_WEAK',
    );
  return { meta, file, shown: null };
}

function slug(): string {
  let out = '';
  // 252 = 7 x 36: bytes above it are dropped so every character is equally likely.
  while (out.length < 8)
    for (const b of randomBytes(16)) if (b < 252 && out.length < 8) out += SLUG_CHARS[b % 36];
  return out;
}

const scopeOf = (k: Pick<KeysetRow, 'id' | 'orgId' | 'mode'>): KeyScope => ({
  orgId: k.orgId,
  mode: k.mode,
  keysetId: k.id,
});

/** Turns the keyset triggers' refusals into stable answers. */
async function commitKeyset(g: { commit(): Promise<unknown> }): Promise<void> {
  try {
    await g.commit();
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    if (text.includes('keyset_limit'))
      throw conflict(
        `${KEYSETS_PER_ORG_MODE} keysets are in use. Disable one first.`,
        'KEYSET_LIMIT',
      );
    if (text.includes('keyset_disabled'))
      throw conflict('This keyset is disabled.', 'KEYSET_DISABLED');
    if (text.includes('tag_key_in_use'))
      throw conflict('Tags still use this version.', 'KEYSET_KEY_IN_USE');
    if (classifyD1Error(error)?.kind === 'unique' || text.includes('tag_key_version'))
      throw conflict('The keyset changed. Reload and retry.', 'KEYSET_CHANGED');
    throw error;
  }
}

/**
 * A new keyset with version 1. Generated keys come back once, in `keys`; entered keys are never echoed. The
 * slug is random and checked unique by the database; a clash retries with a new one.
 */
export async function createKeyset(
  ctx: ServiceContext,
  a: KeysetAuthority,
  input: z.infer<typeof CreateTagKeysetSchema>,
): Promise<MadeKeyset> {
  if ((await liveKeysetCount(ctx.env.DB, a.orgId, a.mode)) >= KEYSETS_PER_ORG_MODE)
    throw conflict(
      `${KEYSETS_PER_ORG_MODE} keysets are in use. Disable one first.`,
      'KEYSET_LIMIT',
    );
  const { meta, file, shown } = pickKeys(input);
  if (shown === null) await assertKeysUnused(ctx, a.orgId, meta, file);
  const ring = await loadKekRing(ctx.env);
  const id = ctx.ids.id();
  const keyId = ctx.ids.id();
  const first = {
    id: keyId,
    version: 1,
    envelope: await sealVersion(
      ring,
      { ...scopeOf({ id, orgId: a.orgId, mode: a.mode }), keyId, version: 1 },
      meta,
      file,
    ),
  };
  for (let attempt = 1; ; attempt++) {
    const g = createKeysetGrant(ctx, a, {
      id,
      name: input.name,
      slug: slug(),
      diversify: input.diversify,
      first,
    });
    try {
      await commitKeyset(g);
      break;
    } catch (error) {
      const clash = error instanceof ConflictError && error.code === 'KEYSET_CHANGED';
      if (!clash || attempt === SLUG_TRIES) throw error;
    }
  }
  return { ...(await keysetView(ctx, a, id)), keys: shown };
}

/**
 * Entered keys must be new to the org: a key any keyset of it, in either mode, has ever used (retired and
 * disabled ones included) is not a rotation, and one key in two keysets lets a tap's slug be swapped for the other.
 */
async function assertKeysUnused(
  ctx: ServiceContext,
  orgId: string,
  meta: Uint8Array,
  file: Uint8Array,
): Promise<void> {
  const ring = await loadKekRing(ctx.env);
  for (const v of await orgVersionEnvelopes(ctx.env.DB, orgId)) {
    const old = await openVersion(
      ring,
      { orgId, mode: v.mode, keysetId: v.keysetId, keyId: v.id, version: v.version },
      v.envelope,
    );
    if ([old.meta, old.file].some((k) => constantTimeEqual(k, meta) || constantTimeEqual(k, file)))
      throw new ValidationError(
        'Enter keys this organization has not used.',
        [],
        'KEYSET_KEY_REUSED',
      );
  }
}

/** Adds version n+1 as active; n keeps verifying as retiring until it is retired. One old version at a time. */
export async function rotateKeyset(
  ctx: ServiceContext,
  a: KeysetAuthority,
  id: string,
  input: z.infer<typeof RotateTagKeysetSchema>,
): Promise<MadeKeyset> {
  const row = await keysetIn(ctx, a, id);
  if (row.disabledAt !== null) throw conflict('This keyset is disabled.', 'KEYSET_DISABLED');
  const versions = (await keyVersionsOf(ctx.env.DB, [id])).get(id) ?? [];
  const active = versions.find((v) => v.state === 'active');
  if (!active) throw conflict('This keyset has no active key.', 'KEYSET_CHANGED');
  const old = versions.find((v) => v.state === 'retiring');
  if (old) throw conflict(`Retire version ${old.version} first.`, 'KEYSET_RETIRE_FIRST');
  const next = Math.max(...versions.map((v) => v.version)) + 1;
  if (next > MAX_VERSION)
    throw conflict('This keyset has used every key version.', 'KEYSET_VERSIONS_USED');
  const { meta, file, shown } = pickKeys(input);
  const ring = await loadKekRing(ctx.env);
  const scope = scopeOf(row);
  if (shown === null) await assertKeysUnused(ctx, row.orgId, meta, file);
  const keyId = ctx.ids.id();
  await commitKeyset(
    rotateKeysetGrant(ctx, a, id, active.version, {
      id: keyId,
      version: next,
      envelope: await sealVersion(ring, { ...scope, keyId, version: next }, meta, file),
    }),
  );
  return { ...(await keysetView(ctx, a, id)), keys: shown };
}

/** Retires an old version once no tag uses it. It no longer verifies. */
export async function retireKeyVersion(
  ctx: ServiceContext,
  a: KeysetAuthority,
  id: string,
  version: number,
): Promise<KeysetView> {
  await keysetIn(ctx, a, id);
  const found = ((await keyVersionsOf(ctx.env.DB, [id])).get(id) ?? []).find(
    (v) => v.version === version,
  );
  if (!found) throw new NotFoundError('Key version not found.', 'KEYSET_KEY_NOT_FOUND');
  if (found.state === 'active')
    throw conflict('Rotate the keys first, or disable the keyset.', 'KEYSET_KEY_ACTIVE');
  if (found.state === 'retired') return keysetView(ctx, a, id);
  if (found.tags > 0)
    throw conflict(`${found.tags} tags still use version ${version}.`, 'KEYSET_KEY_IN_USE');
  await commitKeyset(retireKeyGrant(ctx, a, id, version));
  return keysetView(ctx, a, id);
}

/** Every tag on the keyset is refused from now on. For good: make a new keyset. */
export async function disableKeyset(
  ctx: ServiceContext,
  a: KeysetAuthority,
  id: string,
): Promise<KeysetView> {
  const row = await keysetIn(ctx, a, id);
  if (row.disabledAt === null) await commitKeyset(disableKeysetGrant(ctx, a, id));
  return keysetView(ctx, a, id);
}

export interface VerifyKey {
  version: number;
  metaKey: Uint8Array;
  fileKey: Uint8Array;
  /** The file key is the master of an AN10922 keyset. */
  diversified: boolean;
}

/**
 * The keys a read may be checked with, in order: the active version, then the retiring one. One read gives
 * both, so a retire or a disable that lands meanwhile leaves the answer as of that read. A disabled keyset
 * has none. Opening fails (TAG_KEY_UNREADABLE) if a row's org, mode, keyset or version is not the one it was
 * sealed for. For the verifier (S3); no route calls it.
 */
export async function verifyingKeys(ctx: ServiceContext, keyset: KeysetRow): Promise<VerifyKey[]> {
  if (keyset.disabledAt !== null) return [];
  const ring = await loadKekRing(ctx.env);
  const scope = scopeOf(keyset);
  const out: VerifyKey[] = [];
  for (const v of await versionEnvelopes(ctx.env.DB, keyset.id, ['active', 'retiring'])) {
    const keys = await openVersion(ring, { ...scope, keyId: v.id, version: v.version }, v.envelope);
    out.push({
      version: v.version,
      metaKey: keys.meta,
      fileKey: keys.file,
      diversified: keyset.diversify,
    });
  }
  return out;
}
