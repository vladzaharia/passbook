import { loadKekRing } from '../../platform/crypto.ts';
import { randomBytes } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { KEY_BYTES, type KeyScope, openVersion } from './keyset-seal.ts';
import { type VersionEnvelope, versionEnvelopes } from './repo-keysets.ts';

/** The keyset's active key version, or null when it has none. */
export async function activeVersion(db: D1Database, keysetId: string): Promise<number | null> {
  const [active] = await versionEnvelopes(db, keysetId, ['active']);
  return active?.version ?? null;
}

/** The meta key (K1) of a version that is not retired: a retiring one still verifies the tags keyed under it. */
export async function metaKeyOf(
  ctx: ServiceContext,
  scope: KeyScope,
  version: number,
): Promise<Uint8Array | null> {
  const found: VersionEnvelope | undefined = (
    await versionEnvelopes(ctx.env.DB, scope.keysetId, ['active', 'retiring'])
  ).find((v) => v.version === version);
  if (!found) return null;
  const opened = await openVersion(
    await loadKekRing(ctx.env),
    { ...scope, keyId: found.id, version: found.version },
    found.envelope,
  );
  return opened.meta;
}

/**
 * K0 to K4 for a new tag: K1 is the keyset version's meta key (the verifier needs it before it knows the UID),
 * the rest are random per tag. Drawn once, sealed and committed before any command that carries them is released.
 */
export const newKeys = (meta: Uint8Array): Uint8Array[] => [
  randomBytes(KEY_BYTES),
  meta,
  randomBytes(KEY_BYTES),
  randomBytes(KEY_BYTES),
  randomBytes(KEY_BYTES),
];
