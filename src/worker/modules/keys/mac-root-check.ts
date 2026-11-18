import { parseKekVersion } from '../../platform/mac-key-config.ts';
import { macRootAgrees, secretVersions } from '../../platform/mac-roots.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { writeSystemValue } from '../settings/repo.ts';

export const MAC_ROOTS = 'keys.macRoots';

/**
 * Every run in which a version has both `KEK_V<n>` and `MAC_ROOT_V<n>`: whether they derive the same keys,
 * as `{ "<n>": "match" | "mismatch", at }`. `npm run keys:retire` reads it before it deletes the KEK, so a
 * wrong root is found while the KEK still wins and nothing is broken.
 */
export async function recordMacRoots(ctx: ServiceContext): Promise<void> {
  const both = secretVersions(ctx.env, 'MAC_ROOT').filter((v) =>
    secretVersions(ctx.env, 'KEK').includes(v),
  );
  if (both.length === 0) return;
  const now = ctx.clock.now();
  const value: Record<string, string | number> = { at: now };
  for (const version of both) {
    const agrees = await macRootAgrees(ctx.env, version);
    value[String(version)] = agrees ? 'match' : 'mismatch';
    if (!agrees) ctx.log.error('keys.mac_root', { code: 'MAC_ROOT_MISMATCH', version });
  }
  await writeSystemValue(ctx.env.DB, MAC_ROOTS, value, now);
}

export const KEY_RING = 'keys.ring';

/**
 * Every run: the ring and the MAC pins as this Worker sees them (`wrangler.jsonc` vars and secrets as
 * deployed), so `npm run keys:retire` judges what runs in production, not the local checkout.
 */
export async function recordKeyRing(ctx: ServiceContext): Promise<void> {
  const env = ctx.env as { MAC_KEY_VERSION?: unknown; MAC_KEY_VERSION_PREVIOUS?: unknown };
  const now = ctx.clock.now();
  await writeSystemValue(
    ctx.env.DB,
    KEY_RING,
    {
      at: now,
      pin: parseKekVersion(env.MAC_KEY_VERSION),
      previous: parseKekVersion(env.MAC_KEY_VERSION_PREVIOUS),
      kek: secretVersions(ctx.env, 'KEK'),
      macRoot: secretVersions(ctx.env, 'MAC_ROOT'),
    },
    now,
  );
}
