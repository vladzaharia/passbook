import type { Ref } from './references.ts';
import type { PackageDoc, PartId, RefKind } from './types.ts';

/** The list parts a target of each kind is an item of; `ordered` brings it back by identity. */
const LIST_PARTS: Partial<Record<RefKind, PartId[]>> = {
  field: ['fields'],
  input: ['inputs'],
  action: ['scan.actions'],
  plan: ['scan.access'],
  panel: ['scan.display.panels'],
  row: ['scan.display.panels'],
  chip: ['scan.display.header', 'scan.display.panels'],
  featuredAction: ['pass.featuredActions'],
};
type Entry = PackageDoc['files'][string];
const FILE_KINDS: RefKind[] = ['art', 'walletArt', 'imageSlot'];
const SLOT = /^(?:[\w-]+\.lproj\/)?([A-Za-z]+)(?:@[23]x)?\.png$/;

/** Whether a `theirs` pick on a reference to this kind can bring the target back. */
export const restorable = (kind: RefKind): boolean =>
  kind in LIST_PARTS || FILE_KINDS.includes(kind);

/** Restore keys for references picked `theirs`: `part\0id` for list items, `kind\0id` for files. */
export function restoreKeys(refs: Ref[]): Set<string> {
  const out = new Set<string>();
  for (const r of refs) {
    for (const part of LIST_PARTS[r.kind] ?? []) out.add(`${part}\0${r.id}`);
    if (FILE_KINDS.includes(r.kind)) out.add(`${r.kind}\0${r.id}`);
  }
  return out;
}

/** `merged` with restored files copied from ours, or else theirs. A slot comes whole from one side. */
export function restoreFiles(
  merged: PackageDoc,
  restore: Set<string>,
  ours: PackageDoc,
  theirs: PackageDoc,
): PackageDoc {
  if (!restore.size) return merged;
  const files = { ...merged.files };
  for (const side of [ours, theirs]) {
    const slots = new Set(Object.keys(files).map((n) => SLOT.exec(n)?.[1]));
    for (const [name, e] of Object.entries(side.files)) {
      const slot = SLOT.exec(name)?.[1];
      const file = restore.has(`art\0${name}`) || restore.has(`walletArt\0${name}`);
      const unit = slot !== undefined && restore.has(`imageSlot\0${slot}`) && !slots.has(slot);
      if (!(name in files) && (file || unit)) files[name] = e;
    }
  }
  const names = Object.keys(files).sort();
  return { ...merged, files: Object.fromEntries(names.map((n) => [n, files[n] as Entry])) };
}
