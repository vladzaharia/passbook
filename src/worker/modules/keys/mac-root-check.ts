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
