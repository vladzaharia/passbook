import type { Json } from '../../types.ts';
import { eq, isObj } from './map.ts';
import { entityMaps, walkRefs } from './references.ts';
import type { PackageDoc, PartId, RenameKind } from './types.ts';

export interface RenameStep {
  kind: RenameKind;
  from: string;
  to: string;
}

const KINDS: RenameKind[] = ['action', 'art', 'chip', 'field', 'input', 'panel', 'plan', 'row'];

/** The part a rename of this kind files its conflict under. */
export const PART_OF: Record<RenameKind, PartId> = {
  field: 'fields',
  input: 'inputs',
  action: 'scan.actions',
  plan: 'scan.access',
  panel: 'scan.display.panels',
  row: 'scan.display.panels',
  chip: 'scan.display.header',
  art: 'files.stampArt',
};

/**
 * Upstream renames, base to theirs. An entity counts as renamed when it is gone, exactly one new
 * entity of the same kind appeared, and the two are equal once identity is ignored. The match
 * must be one-to-one both ways or nothing fires.
 */
export function detectRenames(base: PackageDoc, theirs: PackageDoc): RenameStep[] {
  const [mb, mt] = [entityMaps(base), entityMaps(theirs)];
  const out: RenameStep[] = [];
  for (const kind of KINDS) {
    const removed = [...mb[kind].keys()].filter((id) => !mt[kind].has(id));
    const added = [...mt[kind].keys()].filter((id) => !mb[kind].has(id));
    for (const from of removed) {
      const hits = added.filter((a) => eq(mb[kind].get(from), mt[kind].get(a)));
      const back =
        hits[0] === undefined
          ? []
          : removed.filter((r) => eq(mb[kind].get(r), mt[kind].get(hits[0] as string)));
      if (hits.length === 1 && back.length === 1) out.push({ kind, from, to: hits[0] as string });
    }
  }
  return out.sort((a, b) => (a.kind + a.from < b.kind + b.from ? -1 : 1));
}

type Obj = Record<string, Json>;

function renameId(list: Json[] | undefined, key: string, step: RenameStep): void {
  for (const item of list ?? []) if (isObj(item) && item[key] === step.from) item[key] = step.to;
}

function renameKey(o: Obj | undefined, step: RenameStep): Obj | undefined {
  if (!o || !(step.from in o)) return o;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k === step.from ? step.to : k, v]));
}

const list = (v: unknown): Json[] | undefined => (Array.isArray(v) ? v : undefined);

/** A copy of `doc` with the entity renamed and every reference to it rewritten. */
export function renameIn(doc: PackageDoc, step: RenameStep): PackageDoc {
  const out: PackageDoc = {
    passJson: structuredClone(doc.passJson),
    manifest: structuredClone(doc.manifest),
    files: { ...doc.files },
  };
  const man = out.manifest as unknown as Obj;
  const scan = man.scan as Obj | undefined;
  const display = scan?.display as Obj | undefined;
  const panels = list(display?.panels) ?? [];
  const rows = panels.flatMap((p) => list((p as Obj).rows) ?? []);
  switch (step.kind) {
    case 'field':
      for (const style of Object.values(out.passJson as Obj))
        if (isObj(style))
          for (const [g, items] of Object.entries(style))
            if (g.endsWith('Fields')) renameId(list(items), 'key', step);
      break;
    case 'input': {
      const inputs = man.inputs as Obj | undefined;
      if (inputs?.properties) inputs.properties = renameKey(inputs.properties as Obj, step) as Obj;
      const required = list(inputs?.required);
      for (const [i, r] of required?.entries() ?? [])
        if (r === step.from) (required as Json[])[i] = step.to;
      if (man.sample) man.sample = renameKey(man.sample as Obj, step) as Obj;
      break;
    }
    case 'action':
      renameId(list(scan?.actions), 'id', step);
      break;
    case 'plan':
      renameId(list((scan?.access as Obj | undefined)?.plans), 'id', step);
      break;
    case 'panel':
      renameId(panels, 'id', step);
      break;
    case 'row':
      renameId(rows, 'id', step);
      break;
    case 'chip':
      for (const l of [
        list((display?.header as Obj | undefined)?.chips),
        ...(list(display?.variants) ?? []).map((v) =>
          list(((v as Obj).header as Obj | undefined)?.chips),
        ),
        ...rows.map((r) => ((r as Obj).type === 'chips' ? list((r as Obj).items) : undefined)),
      ])
        renameId(l, 'id', step);
      break;
    case 'art':
      if (step.from in out.files) {
        out.files = Object.fromEntries(
          Object.entries(out.files).map(([k, v]) => [k === step.from ? step.to : k, v]),
        );
      }
      break;
  }
  walkRefs(out, (kind, id) => (kind === step.kind && id === step.from ? step.to : undefined));
  return out;
}
