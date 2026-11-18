import type { Json, TemplateManifest } from '../../types.ts';
import { mergeFiles } from './files.ts';
import { mergeManifest } from './manifest.ts';
import { conflictId, eq } from './map.ts';
import { normalize } from './normalize.ts';
import { mergePassJson } from './pass-json.ts';
import { danglingRefs, entityMaps } from './references.ts';
import { detectRenames, PART_OF, renameIn } from './renames.ts';
import type { Change, Conflict, Cx, MergeResult, PackageDoc, Rename, Resolution } from './types.ts';
import {
  alignTo,
  type SchemaGap,
  UPGRADERS,
  type Upgraders,
  upgradeSides,
  VERSION_SITES,
  type VersionSite,
} from './versions.ts';

export interface MergeOptions {
  picks?: Record<string, Resolution>;
  /** Version upgraders; defaults to the shipped registry. */
  upgraders?: Upgraders;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function invalid(o: PackageDoc, conflicts: Conflict[]): MergeResult {
  return { status: 'conflicted', merged: o, conflicts, theirs: [], renames: [] };
}

/**
 * Three-way merge of one template version: `base` is the upstream version the fork incorporates
 * (`null`: none usable, so every difference conflicts), `ours` the fork's head, `theirs` the new
 * upstream. Pure and deterministic. Conflicts are provisionally resolved to ours.
 */
export function mergePackages(
  base: PackageDoc | null,
  ours: PackageDoc,
  theirs: PackageDoc,
  options: MergeOptions = {},
): MergeResult {
  const cx: Cx = {
    twoWay: base === null,
    picks: options.picks ?? {},
    conflicts: [],
    changes: [],
    part: 'manifest.meta',
  };
  const b = base && normalize(base);
  const o = normalize(ours);
  const t0 = normalize(theirs);
  let t = t0;
  const gaps = upgradeSides([b, o, t], options.upgraders ?? UPGRADERS);
  const [ver, ...sites] = VERSION_SITES;
  const gapOf = (g: SchemaGap) => ({
    id: conflictId(g.part, g.path),
    part: g.part,
    path: g.path,
    kind: 'schema_upgrade_missing' as const,
    base: b ? g.versions[0] : undefined,
    ours: g.versions[1],
    theirs: g.versions[2],
  });
  // A schema gap with no upgrader merges nothing; a part's gap keeps ours for that part.
  if (gaps.some((g) => g.part === ver.part)) return invalid(o, gaps.map(gapOf));
  for (const g of gaps) {
    const site = sites.find((s) => s.part === g.part) as VersionSite;
    cx.conflicts.push(gapOf(g));
    if (b) alignTo(b, o, site);
    alignTo(t, o, site);
  }

  // Upstream renames merge as edits under the old identity; the rename is applied afterwards.
  const [mo, mt0] = [entityMaps(o), entityMaps(t0)];
  const mb = b && entityMaps(b);
  const plan = (b ? detectRenames(b, t) : []).map((step) => ({
    step,
    clean:
      eq(mo[step.kind].get(step.from), mb?.[step.kind].get(step.from)) &&
      !mo[step.kind].has(step.to),
  }));
  for (const { step } of plan) t = renameIn(t, { kind: step.kind, from: step.to, to: step.from });

  let merged: PackageDoc = {
    passJson: mergePassJson(cx, b?.passJson, o.passJson, t.passJson),
    manifest: mergeManifest(
      cx,
      b?.manifest as unknown as Json,
      o.manifest,
      t.manifest,
    ) as unknown as TemplateManifest,
    files: mergeFiles(cx, b?.files, o.files, t.files),
  };

  const renames: Rename[] = [];
  for (const { step, clean } of plan) {
    const part = PART_OF[step.kind];
    const picks = cx.picks;
    if (!mo[step.kind].has(step.from)) {
      // Ours deleted it and theirs only renamed it: the deletion stands.
      renames.push({ ...step, applied: false });
      continue;
    }
    const id = conflictId(part, [step.from]);
    let applied = clean;
    if (!clean && picks[id] === 'theirs') applied = true;
    else if (!clean && !picks[id])
      cx.conflicts.push({
        id,
        part,
        path: [step.from],
        kind: 'rename-modify',
        base: step.from,
        ours: step.from,
        theirs: step.to,
      });
    if (applied) {
      merged = renameIn(merged, step);
      cx.changes.push({ part, path: [step.from], op: 'rename' });
    }
    renames.push({ ...step, applied });
  }

  // A reference the merge broke: its target exists in ours or in theirs, but not in the result.
  for (const r of danglingRefs(merged))
    if (mo[r.kind].has(r.id) || mt0[r.kind].has(r.id)) {
      const path = [r.kind, r.id, r.site];
      cx.conflicts.push({
        id: conflictId('references', path),
        part: 'references',
        path,
        kind: 'reference',
        ours: r.id,
        theirs: r.id,
      });
    }

  const conflicts = [...new Map(cx.conflicts.map((c) => [c.id, c])).values()].sort((x, y) =>
    cmp(x.id, y.id),
  );
  const key = (c: Change) => `${c.part}\0${c.path.join('/')}\0${c.op}`;
  const changes = [...new Map(cx.changes.map((c) => [key(c), c])).values()].sort((x, y) =>
    cmp(key(x), key(y)),
  );
  return {
    status: conflicts.length ? 'conflicted' : 'clean',
    merged,
    conflicts,
    theirs: changes,
    renames: renames.sort((x, y) => cmp(x.kind + x.from, y.kind + y.from)),
  };
}

/** The merge with the picked resolutions applied; a conflict without a pick stays ours'. */
export function applyResolutions(
  base: PackageDoc | null,
  ours: PackageDoc,
  theirs: PackageDoc,
  picks: Record<string, Resolution>,
  upgraders?: Upgraders,
): PackageDoc {
  return mergePackages(base, ours, theirs, { picks, upgraders }).merged;
}
