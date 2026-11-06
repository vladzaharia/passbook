/** What a doc reads beyond the pass (DM 5.3), so the server runs only those queries. */
import { condPaths } from './condition.ts';
import type { ScanDisplayDoc } from './schema.ts';
import { parseParts, splitPath } from './text.ts';
import { sourcesOf, walkDoc } from './walk.ts';

export interface ScanDisplayNeeds {
  /** `lastVisit`, `visits`, `scans` and `ledgerMonth:<input>`. */
  history: string[];
  /** Inputs whose ledger (the last scans that changed them) is read. */
  ledger: string[];
  /** The current `pass.json` fields. */
  fields?: boolean;
  /** The pass image assets: the photo, thumbnail and strip. */
  photo?: boolean;
  /** Event counts. */
  event?: boolean;
}

export function compileNeeds(doc: ScanDisplayDoc): ScanDisplayNeeds {
  const needs: ScanDisplayNeeds = {
    history: [],
    ledger: [],
    fields: false,
    photo: doc.photo !== undefined,
    event: false,
  };
  const history = new Set<string>();
  const ledger = new Set<string>();
  const read = (path: string) => {
    const split = splitPath(path);
    if (!split) return;
    const [first, second, third] = split.rest;
    if (split.root === 'fields') needs.fields = true;
    else if (split.root === 'event') needs.event = true;
    else if (split.root === 'history') {
      if (first === 'lastVisit') history.add('lastVisit');
      else if (first === 'visits') history.add('visits');
      else if (first === 'scans' || first === 'lastScan') history.add('scans');
      else if (first === 'ledger' && second)
        if (third === 'month') history.add(`ledgerMonth:${second}`);
        else ledger.add(second);
    }
  };
  const slots = walkDoc(doc);
  for (const slot of slots.texts)
    for (const source of sourcesOf(slot.text))
      for (const part of parseParts(source).parts ?? []) if (part.path) read(part.path);
  for (const slot of slots.exprs)
    for (const part of parseParts(slot.expr).parts ?? []) if (part.path) read(part.path);
  for (const slot of slots.conds) for (const path of condPaths(slot.cond)) read(path);
  for (const panel of doc.panels ?? [])
    for (const row of panel.rows) {
      if (row.type === 'image') needs.photo = true;
      if (row.type !== 'history') continue;
      if (row.source === 'value' && row.input) ledger.add(row.input);
      else if (row.source !== 'value') history.add(row.source);
    }
  needs.history = [...history].sort();
  needs.ledger = [...ledger].sort();
  return needs;
}
