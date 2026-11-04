import type { PassStyle } from '@/passkit/types.ts';
import {
  bindField,
  dropFieldBindings,
  fieldSource,
  renameFieldBindings,
  type Source,
} from './bindings.ts';
import {
  allKeys,
  type DesignDoc,
  type Dict,
  dictOf,
  fieldsOf,
  findField,
  type GroupId,
  groupsFor,
  styleOf,
} from './model.ts';

/** Copies the two documents; assets are replaced, never edited, so they are shared. */
export function copy(doc: DesignDoc): DesignDoc {
  return {
    passJson: structuredClone(doc.passJson),
    manifest: structuredClone(doc.manifest),
    assets: doc.assets,
  };
}

const POSTER: Partial<Record<PassStyle, string[]>> = {
  eventTicket: ['posterEventTicket', 'eventTicket'],
  boardingPass: ['semanticBoardingPass', 'boardingPass'],
};

export const hasPoster = (pass: Dict): boolean =>
  Array.isArray(pass.preferredStyleSchemes) &&
  pass.preferredStyleSchemes.some((s) => s === 'posterEventTicket' || s === 'semanticBoardingPass');

export function setPoster(doc: DesignDoc, on: boolean): DesignDoc {
  const next = copy(doc);
  const schemes = POSTER[styleOf(next.passJson)];
  if (!schemes) return doc;
  if (on) next.passJson.preferredStyleSchemes = schemes;
  else delete next.passJson.preferredStyleSchemes;
  return next;
}

/** Switching style keeps the dictionary and moves fields the new style does not draw to the back. */
export function setStyle(doc: DesignDoc, style: PassStyle): DesignDoc {
  const from = styleOf(doc.passJson);
  if (from === style) return doc;
  const next = copy(doc);
  const old = dictOf(next.passJson);
  delete next.passJson[from];
  const allowed = new Set<string>(groupsFor(style));
  const dict: Dict = {};
  const back = [...(Array.isArray(old.backFields) ? old.backFields : [])];
  for (const [k, v] of Object.entries(old)) {
    if (k === 'transitType') continue;
    if (allowed.has(k)) dict[k] = v;
    else if (Array.isArray(v)) back.push(...v);
  }
  if (back.length) dict.backFields = back;
  if (style === 'boardingPass') dict.transitType = old.transitType ?? 'PKTransitTypeGeneric';
  next.passJson[style] = dict;
  delete next.passJson.preferredStyleSchemes;
  return next;
}

export function setPassProp(doc: DesignDoc, key: string, value: unknown): DesignDoc {
  const next = copy(doc);
  if (value === undefined || value === '') delete next.passJson[key];
  else next.passJson[key] = value;
  return next;
}

export function setDictProp(doc: DesignDoc, key: string, value: unknown): DesignDoc {
  const next = copy(doc);
  const dict = dictOf(next.passJson);
  if (value === undefined || value === '') delete dict[key];
  else dict[key] = value;
  next.passJson[styleOf(next.passJson)] = dict;
  return next;
}

/** A key like `field1`, unique across the pass. */
export function uniqueKey(pass: Dict, base = 'field'): string {
  const taken = new Set(allKeys(pass));
  let n = 1;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

function listOf(next: DesignDoc, group: GroupId): Dict[] {
  const style = styleOf(next.passJson);
  const dict = dictOf(next.passJson);
  const list = Array.isArray(dict[group]) ? (dict[group] as Dict[]) : [];
  dict[group] = list;
  next.passJson[style] = dict;
  return list;
}

export function addField(
  doc: DesignDoc,
  group: GroupId,
  key?: string,
): { doc: DesignDoc; key: string } {
  const next = copy(doc);
  const name = key ?? uniqueKey(next.passJson);
  listOf(next, group).push({ key: name, label: 'Label', value: 'Value' });
  return { doc: next, key: name };
}

export function removeField(doc: DesignDoc, key: string): DesignDoc {
  const at = findField(doc.passJson, key);
  if (!at) return doc;
  const next = copy(doc);
  listOf(next, at.group).splice(at.index, 1);
  next.manifest.bindings = dropFieldBindings(next.manifest, key);
  return next;
}

/** Moves a field to `index` of `group` (same or another group). */
export function moveField(doc: DesignDoc, key: string, group: GroupId, index: number): DesignDoc {
  const at = findField(doc.passJson, key);
  if (!at) return doc;
  const next = copy(doc);
  const [field] = listOf(next, at.group).splice(at.index, 1);
  if (!field) return doc;
  const target = listOf(next, group);
  target.splice(Math.max(0, Math.min(index, target.length)), 0, field);
  return next;
}

/** Shifts a field one place; at a group's edge it stays. Returns the same doc when it cannot move. */
export function nudgeField(doc: DesignDoc, key: string, delta: -1 | 1): DesignDoc {
  const at = findField(doc.passJson, key);
  if (!at) return doc;
  const to = at.index + delta;
  if (to < 0 || to >= fieldsOf(doc.passJson, at.group).length) return doc;
  return moveField(doc, key, at.group, to);
}

export function updateField(doc: DesignDoc, key: string, patch: Dict): DesignDoc {
  const at = findField(doc.passJson, key);
  if (!at) return doc;
  const next = copy(doc);
  const field = listOf(next, at.group)[at.index] as Dict;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete field[k];
    else field[k] = v;
  }
  return next;
}

/** Static text of a field; a link field's anchor follows it. */
export function setFieldValue(doc: DesignDoc, key: string, value: string): DesignDoc {
  const at = findField(doc.passJson, key);
  const field = at ? fieldsOf(doc.passJson, at.group)[at.index] : undefined;
  const link = field?.attributedValue !== undefined;
  return updateField(doc, key, {
    value,
    ...(link ? { attributedValue: `<a href="${value}">${value}</a>` } : {}),
  });
}

export function renameField(doc: DesignDoc, key: string, to: string): DesignDoc {
  if (key === to || to === '' || allKeys(doc.passJson).includes(to)) return doc;
  const next = updateField(doc, key, { key: to });
  next.manifest.bindings = renameFieldBindings(next.manifest, key, to);
  return next;
}

export function setFieldSource(
  doc: DesignDoc,
  key: string,
  source: Source,
  optional: boolean,
): DesignDoc {
  const next = copy(doc);
  next.manifest.bindings = bindField(next.manifest, key, source, { optional });
  const at = findField(next.passJson, key);
  const field = at ? fieldsOf(next.passJson, at.group)[at.index] : undefined;
  if (field?.attributedValue !== undefined)
    next.manifest.bindings = bindLink(next.manifest, key, source, optional);
  return next;
}

/** A link field shows its value as an anchor; bound ones keep the anchor bound too. */
function bindLink(manifest: Dict, key: string, source: Source, optional: boolean): Dict[] {
  if (source.kind !== 'input')
    return bindField(manifest, key, { kind: 'static' }, { prop: 'attributedValue' });
  const n = source.name;
  return bindField(
    manifest,
    key,
    { kind: 'expr', expr: `<a href="{{${n}|html}}">{{${n}|html}}</a>` },
    { prop: 'attributedValue', optional },
  );
}

export function setFieldLink(
  doc: DesignDoc,
  key: string,
  on: boolean,
  optional: boolean,
): DesignDoc {
  const at = findField(doc.passJson, key);
  if (!at) return doc;
  const next = copy(doc);
  const field = listOf(next, at.group)[at.index] as Dict;
  const source = fieldSource(next.manifest, key);
  if (on) {
    const url = typeof field.value === 'string' ? field.value : '';
    field.attributedValue = `<a href="${url}">${url}</a>`;
    next.manifest.bindings = bindLink(next.manifest, key, source, optional);
  } else {
    delete field.attributedValue;
    next.manifest.bindings = bindField(
      next.manifest,
      key,
      { kind: 'static' },
      { prop: 'attributedValue' },
    );
  }
  return next;
}
