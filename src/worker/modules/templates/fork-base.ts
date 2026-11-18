import { isGenerated } from '../../../passkit/template/merge/files.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { canonicalJson } from './package/hash.ts';
import { listVersions, type VersionRow } from './repo.ts';
import { effectiveBase } from './repo-forks.ts';
import { getVersionHashes } from './repo-version-hashes.ts';

export { forkTip, hasApproval, releaseModes, upstreamReadable } from './repo-fork-updates.ts';

/** What a version is, apart from its name, flags and generated files. */
const shape = (v: VersionRow): string => {
  const {
    name: _n,
    org: _o,
    blueprint: _b,
    ...manifest
  } = v.manifest as unknown as Record<string, unknown>;
  return canonicalJson({
    passJson: v.passJson,
    manifest,
    files: v.assets
      .filter((a) => !isGenerated(a.name))
      .map((a) => `${a.name}:${a.sha1}`)
      .sort(),
  });
};

export interface ResolvedBase {
  /** The upstream version the fork's tip incorporates; the one to merge from. */
  upstreamVersion: string;
  contentHash: string | null;
  /** Not recorded: a base row must be written for the tip. */
  inferred: boolean;
  /** No usable base existed: adopt the upstream's current version and offer nothing. */
  adopt: boolean;
}

/**
 * The tip's base. Without a recorded one: an upstream version equal to the fork's first version, else the newest upstream version no younger than the fork, else the upstream's current
 * version, adopted (a fork with no history is not offered every difference as a clash).
 */
export async function resolveBase(
  ctx: ServiceContext,
  o: { forkId: string; upstreamId: string; forkCreatedAt: number; upstreamVersion: string },
  tip: string,
): Promise<ResolvedBase> {
  const db = ctx.env.DB;
  const recorded = await effectiveBase(db, o.forkId, tip);
  if (recorded) return { ...recorded, inferred: false, adopt: false };
  const [own, upstream] = await Promise.all([
    listVersions(db, o.forkId),
    listVersions(db, o.upstreamId),
  ]);
  const first = own.at(-1);
  const pick = async (v: VersionRow | undefined, adopt = false): Promise<ResolvedBase | null> =>
    v
      ? {
          upstreamVersion: v.version,
          contentHash: (await getVersionHashes(db, o.upstreamId, v.version))?.contentHash ?? null,
          inferred: true,
          adopt,
        }
      : null;
  const exact = first && upstream.find((v) => shape(v) === shape(first));
  const young = upstream.find((v) => v.createdAt <= o.forkCreatedAt);
  const current = upstream.find((v) => v.version === o.upstreamVersion);
  const found = (await pick(exact)) ?? (await pick(young)) ?? (await pick(current, true));
  if (!found) throw new Error('The upstream version is missing.');
  return found;
}
