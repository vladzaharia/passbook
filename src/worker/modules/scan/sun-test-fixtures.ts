import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { loadKekRing } from '../../platform/crypto.ts';
import { first, run } from '../../platform/db.ts';
import { resolveSession } from '../auth/sessions.ts';
import { aesCmac } from '../nfc/aes-cmac.ts';
import { diversifyKey } from '../nfc/diversify.ts';
import { sealTagKey, sealVersion } from '../nfc/keyset-seal.ts';
import { keysetAuthorityOf } from '../nfc/keysets.ts';
import { bytesToHex, hexToBytes } from '../nfc/sun.ts';
import { tagRef } from '../nfc/tag-ref.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { grantScanMembership, type ScanKit } from './test-kit.ts';

export const ZERO = new Uint8Array(16);
const h = (hex: string) => hexToBytes(hex) as Uint8Array;
const random = () => crypto.getRandomValues(new Uint8Array(16));

export interface SunKeyset {
  id: string;
  slug: string;
  orgId: string;
  mode: 'live' | 'test';
  meta: Uint8Array;
  file: Uint8Array;
  diversify: boolean;
  /** The tags carry their own file keys. */
  perTag: boolean;
}

let seq = 0;
const slugOf = () => `k${(++seq).toString(36).padStart(7, '0')}`;

/** A keyset with version 1 active, inserted as a keyset create would (keys sealed under the platform KEK). */
export async function sunKeyset(
  kit: Pick<ScanKit, 'env' | 'fx' | 'clock'>,
  orgId: string,
  options: {
    mode?: 'live' | 'test';
    diversify?: boolean;
    perTag?: boolean;
    meta?: Uint8Array;
    file?: Uint8Array;
  } = {},
): Promise<SunKeyset> {
  const mode = options.mode ?? 'live';
  const keyset: SunKeyset = {
    id: kit.fx.ids.id(),
    slug: slugOf(),
    orgId,
    mode,
    meta: options.meta ?? random(),
    file: options.file ?? random(),
    diversify: options.diversify ?? false,
    perTag: options.perTag ?? false,
  };
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO nfc_tag_keysets (id, org_id, mode, name, slug, diversify, per_tag, created_at, created_by)
     VALUES (?, ?, ?, 'Badges', ?, ?, ?, ?, 'test')`,
    [keyset.id, orgId, mode, keyset.slug, keyset.diversify ? 1 : 0, keyset.perTag ? 1 : 0, now],
  );
  await addKeyVersion(kit, keyset, 1, keyset.meta, keyset.file);
  return keyset;
}

/** Another version of a keyset, active; the one before it is made retiring or retired. */
export async function addKeyVersion(
  kit: Pick<ScanKit, 'env' | 'fx' | 'clock'>,
  keyset: SunKeyset,
  version: number,
  meta: Uint8Array,
  file: Uint8Array,
): Promise<void> {
  const keyId = kit.fx.ids.id();
  const e = await sealVersion(
    await loadKekRing(kit.env),
    { orgId: keyset.orgId, mode: keyset.mode, keysetId: keyset.id, keyId, version },
    meta,
    file,
  );
  await run(
    kit.env.DB,
    `INSERT INTO nfc_tag_keys (id, keyset_id, version, kek_version, iv, wrapped_dek, ciphertext, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    [keyId, keyset.id, version, e.kekVersion, e.iv, e.wrappedDek, e.ciphertext, kit.clock.now()],
  );
}

/** What a tag emits on one tap: its PICCData encrypted under the meta key and the MAC under the file key. */
export async function sunTap(
  keyset: Pick<SunKeyset, 'slug' | 'meta' | 'file' | 'diversify'>,
  uid: string,
  ctr: number,
  options: { host?: string; slug?: string; p?: string; m?: string; tagKey?: Uint8Array } = {},
) {
  const uidBytes = h(uid);
  const counter = new Uint8Array([ctr & 0xff, (ctr >> 8) & 0xff, (ctr >> 16) & 0xff]);
  const plain = new Uint8Array(16);
  plain[0] = 0xc7;
  plain.set(uidBytes, 1);
  plain.set(counter, 8);
  const metaKey = await crypto.subtle.importKey('raw', keyset.meta, { name: 'AES-CBC' }, false, [
    'encrypt',
  ]);
  const p = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, metaKey, plain),
  ).slice(0, 16);
  const fileKey =
    options.tagKey ?? (keyset.diversify ? await diversifyKey(keyset.file, uidBytes) : keyset.file);
  const sv2 = h(`3cc300010080${uid}${bytesToHex(counter)}`);
  const mac = (await aesCmac(await aesCmac(fileKey, sv2), new Uint8Array(0))).filter(
    (_, i) => i % 2,
  );
  const url = `https://${options.host ?? 'passbook.mobile'}/t/${options.slug ?? keyset.slug}?p=${options.p ?? bytesToHex(p)}&m=${options.m ?? bytesToHex(mac)}`;
  return {
    uid,
    tech: 'isodep' as const,
    source: 'native' as const,
    ndef: { type: 'U' as const, value: url },
  };
}

/** A Secure tag already enrolled: its row, side row and a binding to the pass, as an assign would leave them. */
export async function enrolledSunTag(
  kit: Pick<ScanKit, 'env' | 'fx' | 'clock'>,
  keyset: SunKeyset,
  uid: string,
  pass: { id: string; orgId: string; mode: 'live' | 'test' },
  ctr: number,
  ownKey?: Uint8Array,
) {
  const { ref, hint } = await tagRef(kit.env, keyset.orgId, keyset.mode, uid);
  const tagId = kit.fx.ids.id();
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, hint, created_at) VALUES (?, ?, ?, ?, 'sun', ?, ?)`,
    [tagId, keyset.orgId, keyset.mode, ref, hint, now],
  );
  if (ownKey) {
    const e = await sealTagKey(
      await loadKekRing(kit.env),
      { orgId: keyset.orgId, mode: keyset.mode, keysetId: keyset.id },
      tagId,
      ownKey,
    );
    await run(
      kit.env.DB,
      `INSERT INTO nfc_tag_sun (tag_id, keyset_id, key_version, kek_version, iv, wrapped_dek, ciphertext, ctr, ctr_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      [tagId, keyset.id, e.kekVersion, e.iv, e.wrappedDek, e.ciphertext, ctr, now],
    );
  } else
    await run(
      kit.env.DB,
      'INSERT INTO nfc_tag_sun (tag_id, keyset_id, key_version, ctr, ctr_at) VALUES (?, ?, 1, ?, ?)',
      [tagId, keyset.id, ctr, now],
    );
  const owner = await first<{ owner_user_id: string | null; credential_generation: number }>(
    kit.env.DB,
    'SELECT owner_user_id, credential_generation FROM passes WHERE id = ?',
    [pass.id],
  );
  const bindingId = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO tag_bindings (id, tag_id, scope, pass_id, user_id, source, bound_at, bound_by_type, bound_by,
       holder_generation, holder_owner) VALUES (?, ?, 'pass', ?, NULL, 'admin', ?, 'user', 'admin-1', ?, ?)`,
    [
      bindingId,
      tagId,
      pass.id,
      now,
      owner?.credential_generation ?? 1,
      owner?.owner_user_id ?? null,
    ],
  );
  return { tagId, bindingId, ref };
}

export const sunCounter = async (kit: Pick<ScanKit, 'env'>, tagId: string) =>
  (
    await first<{ ctr: number }>(kit.env.DB, 'SELECT ctr FROM nfc_tag_sun WHERE tag_id = ?', [
      tagId,
    ])
  )?.ctr;

/** The captured scanning:manage authority of a new org admin, as a keyset route builds it. */
export async function keysetAdmin(
  kit: Pick<ScanKit, 'env' | 'fx' | 'clock' | 'ctx'>,
  orgId: string,
  mode: 'live' | 'test' = 'live',
) {
  const user = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, orgId, user.id, ['org_admin']);
  const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
  const resolved = await resolveSession(kit.env, kit.clock, session.cookieValue);
  if (!resolved) throw new Error('The admin session did not resolve.');
  return keysetAuthorityOf(
    await tenantAuthorityOf(kit.ctx, { ...resolved, mode }, orgId, 'scanning:manage'),
  );
}
