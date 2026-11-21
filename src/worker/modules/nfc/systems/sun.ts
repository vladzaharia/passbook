import type { Mode } from '../../../../shared/contracts/common.ts';
import type { TagRead } from '../../../../shared/contracts/nfc-tags.ts';
import { loadKekRing } from '../../../platform/crypto.ts';
import { redirectHosts } from '../../../platform/host-policy.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { openTagKey } from '../keyset-seal.ts';
import { verifyingKeys } from '../keysets.ts';
import { type KeysetRow, keysetBySlug } from '../repo-keysets.ts';
import { type SunSeen, type SunStored, sunStoredByRef, sunTagKeyByRef } from '../repo-sun.ts';
import { verifySun } from '../sun.ts';
import { parseSunUrl, type SunUrl } from '../sun-url.ts';
import { tagRef } from '../tag-ref.ts';
import type { TagEnv, TagIdentity, TagSystem } from './types.ts';

/** A gap this large since the tag's last use means reads nobody presented (a phone opening `/t/` in a pocket). */
export const SUN_GAP = 1000;

/** Why a SUN read was refused. Logged, never returned: the answer to the tap is `tag_invalid`. */
export type SunRefusalCode =
  | 'TAG_SUN_KEYSET'
  | 'TAG_SUN_MODE'
  | 'TAG_SUN_VERIFY'
  | 'TAG_SUN_REPLAY'
  | 'TAG_SUN_VERSION'
  | 'TAG_SUN_ROW';

/** A read the plugin verified: the tag's identity in this org and mode, and the counter and key that proved it. */
export type SunProof = TagIdentity &
  SunSeen & {
    /** The key version is the keyset's active one: a retiring version verifies known tags only. */
    active: boolean;
  };

export type SunVerified =
  | { ok: true; proof: SunProof }
  /** `reason` is what the door answers: `test_pass`/`live_pass` when the keyset is the org's other mode. */
  | { ok: false; code: SunRefusalCode; reason: 'tag_invalid' | 'test_pass' | 'live_pass' };

const refuse = (
  code: SunRefusalCode,
  reason: 'tag_invalid' | 'test_pass' | 'live_pass' = 'tag_invalid',
): SunVerified => ({ ok: false, code, reason });

const hostsOf = (env: TagEnv): string[] => [
  new URL(env.PUBLIC_BASE_URL).host,
  ...redirectHosts(env),
];

/** The URL a read carries, if it is on one of our hosts and shaped as a tap: `https://{host}/t/{slug}?p=..&m=..`. */
export function sunTapOf(read: TagRead, env: TagEnv): SunUrl | null {
  if (read.ndef?.type !== 'U') return null;
  const tap = parseSunUrl(read.ndef.value);
  return tap && hostsOf(env).includes(tap.host) ? tap : null;
}

/**
 * The own file key of the tag a read names, on a keyset whose tags carry their own (imported): found by the
 * UID the meta key revealed, opened only for that tag, keyset, mode and org. Null when the tag holds none:
 * it is refused, never tried with the keyset's key.
 */
function tagKeyLookup(ctx: ServiceContext, keyset: KeysetRow) {
  const found = new Map<string, Uint8Array | null>();
  return async (uid: string): Promise<Uint8Array | null> => {
    if (found.has(uid)) return found.get(uid) ?? null;
    const { ref } = await tagRef(ctx.env, keyset.orgId, keyset.mode, uid);
    const own = await sunTagKeyByRef(ctx.env.DB, keyset.orgId, keyset.mode, keyset.id, ref);
    const key = own
      ? await openTagKey(
          await loadKekRing(ctx.env),
          { orgId: keyset.orgId, mode: keyset.mode, keysetId: keyset.id },
          own.tagId,
          own.envelope,
        )
      : null;
    found.set(uid, key);
    return key;
  };
}

/**
 * The slug names the keyset, which must be this org's, in this mode and not disabled; then the read is
 * decrypted and checked with its active key, then its retiring one. The tag's identity comes from the
 * decrypted UID only, never from a UID the reader reports. Reads, writes nothing, consumes no counter.
 */
export async function verifySunTap(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  read: TagRead,
): Promise<SunVerified> {
  const tap = sunTapOf(read, ctx.env);
  if (!tap) return refuse('TAG_SUN_KEYSET');
  const keyset = await keysetBySlug(ctx.env.DB, tap.slug);
  if (!keyset || keyset.orgId !== orgId || keyset.disabledAt !== null)
    return refuse('TAG_SUN_KEYSET');
  const lookup = keyset.perTag ? tagKeyLookup(ctx, keyset) : null;
  for (const key of await verifyingKeys(ctx, keyset)) {
    const verified = await verifySun(
      { metaKey: key.metaKey, fileKey: lookup ?? key.fileKey, diversified: key.diversified },
      tap.p,
      tap.m,
    );
    if (!verified.ok) continue;
    // Said only once the MAC holds: an unproven slug learns nothing about the org's other mode.
    if (keyset.mode !== mode)
      return refuse('TAG_SUN_MODE', mode === 'live' ? 'test_pass' : 'live_pass');
    const { ref, hint } = await tagRef(ctx.env, orgId, mode, verified.read.uid);
    return {
      ok: true,
      proof: {
        ref,
        hint,
        keysetId: keyset.id,
        slug: keyset.slug,
        keyVersion: key.version,
        ctr: verified.read.counter,
        active: key.active,
      },
    };
  }
  return refuse('TAG_SUN_VERIFY');
}

/**
 * Whether a verified read may be used on the tag it names: the counter strictly above the last one used, on
 * the keyset and a key version no lower than the tag's. A new tag (no side row) has nothing to replay.
 * Logs a gap; the caller logs the refusal.
 */
export function sunStale(
  ctx: ServiceContext,
  orgId: string,
  proof: Omit<SunProof, 'active'>,
  stored: SunStored | null,
): SunRefusalCode | null {
  if (!stored) return null;
  if (stored.keysetId !== proof.keysetId) return 'TAG_SUN_KEYSET';
  if (proof.keyVersion < stored.keyVersion) return 'TAG_SUN_VERSION';
  if (proof.ctr <= stored.ctr) return 'TAG_SUN_REPLAY';
  if (proof.ctr - stored.ctr > SUN_GAP)
    ctx.log.info('scan.tag_sun_gap', { orgId, code: 'TAG_SUN_GAP' });
  return null;
}

/** The refusal a lost race at commit stands for: the read was used in between. Null when it is still fresh or the tag is new. */
export async function sunStaleNow(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  proof: SunProof,
): Promise<SunRefusalCode | null> {
  return sunStale(ctx, orgId, proof, await sunStoredByRef(ctx.env.DB, orgId, mode, proof.ref));
}

/** Secure: a signed read per tap. Recognised by its URL on our host, so a SUN tag is never read as a UID. */
export const SUN_SYSTEM: TagSystem = {
  id: 'sun',
  assurance: 'secure',
  ready: true,
  recognise: (read, env) => (sunTapOf(read, env) ? { system: 'sun' } : null),
};
