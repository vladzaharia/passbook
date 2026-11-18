import type { z } from 'zod';
import { isGenerated } from '../../../passkit/template/merge/files.ts';
import type {
  Conflict,
  MergeResult,
  PackageDoc,
  Resolution,
} from '../../../passkit/template/merge/index.ts';
import { normalize } from '../../../passkit/template/merge/normalize.ts';
import type { Json } from '../../../passkit/types.ts';
import type { VersionAssetInputSchema } from '../../../shared/contracts/index.ts';
import type { FieldIssue } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { readBranding } from '../passes/branding.ts';
import { canonicalJson } from './package/hash.ts';
import { readReleaseAsset } from './release-content.ts';
import type { VersionRow } from './repo.ts';

type AssetInput = z.infer<typeof VersionAssetInputSchema>;

/** Files the engine merges by their contents: `.strings` and `personalization.json`. */
const needsBytes = (name: string) =>
  /^[\w-]+\.lproj\/pass\.strings$/.test(name) || name === 'personalization.json';

/** One side of a merge, from a stored version. Bytes are read, and verified, only where the engine needs them. */
export async function docOf(ctx: ServiceContext, v: VersionRow): Promise<PackageDoc> {
  const files: PackageDoc['files'] = {};
  for (const a of v.assets) {
    if (isGenerated(a.name)) continue;
    files[a.name] = {
      sha1: a.sha1,
      ...(needsBytes(a.name) ? { bytes: await readReleaseAsset(ctx, a) } : {}),
    };
  }
  return { passJson: v.passJson as unknown as Json, manifest: v.manifest, files };
}

/** What the org's branding replaces on every pass, so a clash there changes nothing for holders. */
function overriddenKeys(brandingJson: string | null): Set<string> {
  const { colors } = readBranding(brandingJson ? JSON.parse(brandingJson) : {});
  const keys = new Set(['logoText', 'eventLogoText']);
  if (colors?.background) keys.add('backgroundColor');
  if (colors?.foreground) keys.add('foregroundColor');
  if (colors?.label) keys.add('labelColor');
  return keys;
}

const VALUE_CLASHES = new Set(['both-changed', 'add-add', 'delete-modify', 'modify-delete']);

/**
 * "Kept yours": clashes the org already decides. Art clashes on images and stamp art, and values its
 * branding replaces, keep the fork's side. The picks are the system's, never a person's.
 */
export function keptYours(
  conflicts: readonly Conflict[],
  brandingJson: string | null,
): Record<string, Resolution> {
  const overridden = overriddenKeys(brandingJson);
  const picks: Record<string, Resolution> = {};
  for (const c of conflicts) {
    const art = c.kind === 'binary' && (c.part === 'files.image' || c.part === 'files.stampArt');
    const branded =
      c.part === 'pass.meta' &&
      VALUE_CLASHES.has(c.kind) &&
      c.path.length === 1 &&
      overridden.has(c.path[0] ?? '');
    if (art || branded) picks[c.id] = 'ours';
  }
  return picks;
}

/** What the review shows and the banner counts. */
export function summaryOf(
  r: MergeResult,
  base: { version: string | null; inferred: boolean },
  kept: readonly Conflict[],
): object {
  const byPart: Record<string, number> = {};
  for (const c of r.theirs) byPart[c.part] = (byPart[c.part] ?? 0) + 1;
  return {
    changes: r.theirs.length,
    byPart,
    renames: r.renames.filter((x) => x.applied).length,
    keptYours: kept.map((c) => ({ id: c.id, part: c.part, path: c.path })),
    base,
  };
}

/** Whether two sides are the same content: pass.json, the manifest and the files, apart from generated ones. */
export function sameDoc(a: PackageDoc, b: PackageDoc): boolean {
  const key = (d: PackageDoc) => {
    const n = normalize(d);
    return canonicalJson({
      passJson: n.passJson,
      manifest: n.manifest,
      files: Object.entries(n.files)
        .map(([name, f]) => `${name}:${f.sha1}`)
        .sort(),
    });
  };
  return key(a) === key(b);
}

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * The merged document as a designer save: each file is named by hash (its bytes live in ours or in
 * the upstream), except one the merge wrote itself, which is sent as bytes.
 */
export function saveBody(merged: PackageDoc, ours: PackageDoc, theirs: PackageDoc) {
  const assets: AssetInput[] = Object.entries(merged.files).map(([name, f]) => {
    const known = f.sha1 === ours.files[name]?.sha1 || f.sha1 === theirs.files[name]?.sha1;
    return !known && f.bytes ? { name, upload: base64(f.bytes) } : { name, sha1: f.sha1 };
  });
  return {
    passJson: merged.passJson as Record<string, Json>,
    manifest: merged.manifest as unknown as Record<string, Json>,
    assets,
  };
}

/** Where a refusal belongs, by the first segment of its path. */
const PART_BY_ROOT: Record<string, string> = {
  bindings: 'bindings',
  inputs: 'inputs',
  sample: 'sample',
  lookups: 'lookups',
  display: 'display',
  behaviors: 'behaviors',
  stamps: 'stamps',
  wallets: 'wallets',
  scan: 'scan.meta',
  nfc: 'nfc',
};

/** The save pipeline's errors as conflicts of kind `invalid`, for the resolver. */
export function invalidConflicts(issues: readonly FieldIssue[]): Conflict[] {
  return issues.map((i, n) => {
    const root = i.path.split(/[./[]/)[0] ?? '';
    const file = /\.(png|strings)$|\.json$/.test(i.path);
    return {
      id: `references:invalid/${n}`,
      part: (PART_BY_ROOT[root] ?? (file ? 'files.other' : 'pass.meta')) as Conflict['part'],
      path: [i.path],
      kind: 'invalid' as const,
      ours: i.message,
    };
  });
}
