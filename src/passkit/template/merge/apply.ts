import type { TemplateManifest } from '../../types.ts';
import { mergeFiles } from './files.ts';
import { mergeManifest } from './manifest.ts';
import { canon, conflictId, eq } from './map.ts';
import { normalize } from './normalize.ts';
import { mergePassJson } from './pass-json.ts';
import { brokenRefs, entityMaps, type Ref } from './references.ts';
import { detectRenames, PART_OF, renameIn } from './renames.ts';
import { restorable, restoreFiles, restoreKeys } from './restore.ts';
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
const refId = (r: Ref) => conflictId('references', [r.kind, r.id, r.site]);

/** One pass of the merge over normalized, upgraded sides. `restore` comes from reference picks. */
function run(
  b: PackageDoc | null,
  o: PackageDoc,
  t0: PackageDoc,
  picks: Record<string, Resolution>,
  restore: Set<string>,
) {
  const cx: Cx = {
    twoWay: b === null,
    picks,
    conflicts: [],
    changes: [],
    part: 'manifest.meta',
    restore,
  };
  const [mo, mb] = [entityMaps(o), b && entityMaps(b)];
  // Upstream renames merge as edits under the old identity and are applied afterwards. A rename
  // onto a name ours already uses is not offered: it merges as a delete plus an add.
  const steps = b ? detectRenames(b, t0) : [];
  const plan = steps.map((step) => ({
    step,
    taken: mo[step.kind].has(step.to),
    clean: eq(mo[step.kind].get(step.from), mb?.[step.kind].get(step.from)),
  }));
  let t = t0;
  for (const { step, taken } of plan)
    if (!taken) t = renameIn(t, { kind: step.kind, from: step.to, to: step.from });

  let merged: PackageDoc = {
    passJson: mergePassJson(cx, b?.passJson, o.passJson, t.passJson),
    manifest: mergeManifest(cx, b?.manifest, o.manifest, t.manifest) as unknown as TemplateManifest,
    files: mergeFiles(cx, b?.files, o.files, t.files),
  };
  merged = restoreFiles(merged, restore, o, t);

  const renames: Rename[] = [];
  for (const { step, clean, taken } of plan) {
    const part = PART_OF[step.kind];
    // Ours deleted it and theirs only renamed it, or ours took the new name: no rename.
    if (taken || !mo[step.kind].has(step.from)) {
      renames.push({ ...step, applied: false });
      continue;
    }
    const id = conflictId(part, [step.from]);
    const applied = clean || picks[id] === 'theirs';
    if (!applied && picks[id] !== 'ours')
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
  const broken = brokenRefs(merged, b, o, [t0, t]);
  return { merged, cx, renames, broken, t };
}

/** Conflicts sorted by id. One id is one decision: two different conflicts under one id is a bug. */
function sortConflicts(list: Conflict[]): Conflict[] {
  const byId = new Map<string, Conflict>();
  for (const c of list) {
    const seen = byId.get(c.id);
    if (seen && canon(seen as never) !== canon(c as never))
      throw new Error(`merge: two conflicts share the id ${c.id}`);
    byId.set(c.id, c);
  }
  return [...byId.values()].sort((x, y) => cmp(x.id, y.id));
}

function gapConflict(g: SchemaGap, hasBase: boolean): Conflict {
  return {
    id: conflictId(g.part, g.path),
    part: g.part,
    path: g.path,
    kind: 'schema_upgrade_missing',
    base: hasBase ? g.versions[0] : undefined,
    ours: g.versions[1],
    theirs: g.versions[2],
  };
}

/**
 * Three-way merge of one template version: `base` is the upstream version the fork incorporates
 * (`null`: none usable, so every difference conflicts), `ours` the fork's head, `theirs` the new
 * upstream. Pure and deterministic. Conflicts are provisionally resolved to ours.
 *
 * A `reference` conflict takes `ours` (keep the merge as it is) or `theirs` (bring the target back
 * from ours, or else theirs; a barcode index cannot come back, so `theirs` keeps it too). A
 * `schema_upgrade_missing` conflict takes `ours` or `theirs` for its whole site.
 */
export function mergePackages(
  base: PackageDoc | null,
  ours: PackageDoc,
  theirs: PackageDoc,
  options: MergeOptions = {},
): MergeResult {
  const picks = options.picks ?? {};
  const b = base && normalize(base);
  const o = normalize(ours);
  const t0 = normalize(theirs);
  const gaps = upgradeSides([b, o, t0], options.upgraders ?? UPGRADERS).map((g) => ({
    g,
    c: gapConflict(g, b !== null),
  }));
  const [ver, ...sites] = VERSION_SITES;
  const sided = (pick?: Resolution) => pick === 'ours' || pick === 'theirs';
  const schema = gaps.filter(({ g }) => g.part === ver.part);
  if (schema.length) {
    // A schema gap merges nothing: the result is one side, whole.
    const pick = picks[schema[0]?.c.id as string];
    const merged =
      pick === 'theirs' ? { ...t0, manifest: { ...t0.manifest, name: o.manifest.name } } : o;
    const left = sided(pick) ? [] : gaps.map(({ c }) => c);
    return {
      status: left.length ? 'conflicted' : 'clean',
      merged,
      conflicts: left,
      theirs: [],
      renames: [],
    };
  }
  const gapConflicts: Conflict[] = [];
  for (const { g, c } of gaps) {
    // A part's gap keeps that part whole from one side: ours unless theirs is picked.
    const site = sites.find((s) => s.part === g.part) as VersionSite;
    const pick = picks[c.id];
    const [keep, others] = pick === 'theirs' ? [t0, [b, o]] : [o, [b, t0]];
    for (const d of others) if (d) alignTo(d, keep, site);
    if (!sided(pick)) gapConflicts.push(c);
  }

  // A reference picked `theirs` brings its target back: a second pass with those targets kept.
  const first = run(b, o, t0, picks, new Set());
  const restore = restoreKeys(first.broken.filter((r) => picks[refId(r)] === 'theirs'));
  const pass = restore.size ? run(b, o, t0, picks, restore) : first;
  const [mo, mt] = [entityMaps(o), entityMaps(pass.t)];
  const refConflicts = pass.broken
    .filter((r) => {
      const pick = picks[refId(r)];
      // A restorable target still missing after the second pass keeps its conflict.
      return !(pick === 'ours' || (pick === 'theirs' && !restorable(r.kind)));
    })
    .map(
      (r): Conflict => ({
        id: refId(r),
        part: 'references',
        path: [r.kind, r.id, r.site],
        kind: 'reference',
        ours: mo[r.kind].get(r.id),
        theirs: mt[r.kind].get(r.id) ?? entityMaps(t0)[r.kind].get(r.id),
      }),
    );
  const conflicts = sortConflicts([...gapConflicts, ...pass.cx.conflicts, ...refConflicts]);
  const key = (c: Change) => `${c.part}\0${c.path.join('/')}\0${c.op}`;
  const changes = [...new Map(pass.cx.changes.map((c) => [key(c), c])).values()].sort((x, y) =>
    cmp(key(x), key(y)),
  );
  return {
    status: conflicts.length ? 'conflicted' : 'clean',
    merged: pass.merged,
    conflicts,
    theirs: changes,
    renames: pass.renames.sort((x, y) => cmp(x.kind + x.from, y.kind + y.from)),
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
