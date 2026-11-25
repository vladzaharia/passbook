import type { PassStyle } from '@/passkit/types.ts';
import {
  bindField,
  dropFieldBindings,
  fieldSource,
  renameFieldBindings,
  type Source,
} from './bindings.ts';
import {
  type DesignDoc,
  type Dict,
  dictOf,
  everyKey,
  fieldsOf,
  findField,
  type GroupId,
  groupsFor,
  isRecord,
  legacyStyleOf,
  styleOf,
  type Target,
} from './model.ts';

/** Copies the two documents; assets are replaced, never edited, so they are shared. */
export function copy(doc: DesignDoc): DesignDoc {
  return {
    passJson: structuredClone(doc.passJson),
    manifest: structuredClone(doc.manifest),
    assets: doc.assets,
    target: doc.target,
  };
}

const POSTER: Partial<Record<PassStyle, string[]>> = {
  eventTicket: ['posterEventTicket', 'eventTicket'],
  boardingPass: ['semanticBoardingPass', 'boardingPass'],
};

export const hasPoster = (pass: Dict): boolean =>
  isRecord(pass.posterGeneric) ||
  (Array.isArray(pass.preferredStyleSchemes) &&
    pass.preferredStyleSchemes.some(
      (s) => s === 'posterEventTicket' || s === 'semanticBoardingPass',
    ));

const POSTER_LIMIT = { headerFields: 1, primaryFields: 4 } as const;

/** Generic's fields laid out in the poster groups; what does not fit goes to additional info. */
function posterFrom(generic: Dict): Dict {
  const list = (g: string): Dict[] => (Array.isArray(generic[g]) ? (generic[g] as Dict[]) : []);
  const header = list('headerFields');
  const primary = list('primaryFields');
  const dict: Dict = {
    headerFields: header.slice(0, POSTER_LIMIT.headerFields),
    primaryFields: primary.slice(0, POSTER_LIMIT.primaryFields),
    additionalInfoFields: [
      ...header.slice(POSTER_LIMIT.headerFields),
      ...primary.slice(POSTER_LIMIT.primaryFields),
      ...list('secondaryFields'),
      ...list('auxiliaryFields'),
    ],
    footerFields: [],
    backFields: list('backFields'),
  };
  return structuredClone(dict);
}

/** The reverse, for a draft that has only the poster layout. */
function genericFrom(poster: Dict): Dict {
  const list = (g: string): Dict[] => (Array.isArray(poster[g]) ? (poster[g] as Dict[]) : []);
  return structuredClone({
    headerFields: list('headerFields'),
    primaryFields: list('primaryFields').slice(0, 1),
    secondaryFields: [...list('primaryFields').slice(1), ...list('additionalInfoFields')],
    auxiliaryFields: list('footerFields'),
    backFields: list('backFields'),
  });
}

export function setPoster(doc: DesignDoc, on: boolean): DesignDoc {
  const next = copy(doc);
  const style = legacyStyleOf(next.passJson);
  if (style === 'generic') {
    if (on) {
      if (isRecord(next.passJson.posterGeneric)) return doc;
      const generic = isRecord(next.passJson.generic) ? next.passJson.generic : {};
      next.passJson.posterGeneric = posterFrom(generic);
    } else {
      if (!isRecord(next.passJson.posterGeneric)) return doc;
      delete next.passJson.posterGeneric;
      next.target = undefined;
    }
    return next;
  }
  const schemes = POSTER[style];
  if (!schemes) return doc;
  if (on) next.passJson.preferredStyleSchemes = schemes;
  else delete next.passJson.preferredStyleSchemes;
  return next;
}

/** Repairs a draft that has posterGeneric alone: Generic is made from the poster fields. */
export function addGenericLayout(doc: DesignDoc): DesignDoc {
  const poster = doc.passJson.posterGeneric;
  if (
    !isRecord(poster) ||
    legacyStyleOf(doc.passJson) !== 'generic' ||
    isRecord(doc.passJson.generic)
  )
    return doc;
  const next = copy(doc);
  next.passJson.generic = genericFrom(poster);
  return next;
}

export function setTarget(doc: DesignDoc, target: Target): DesignDoc {
  if (doc.target === target) return doc;
  return { ...doc, target };
}

/** Switching style keeps the dictionary and moves fields the new style does not draw to the back. */
export function setStyle(doc: DesignDoc, style: PassStyle): DesignDoc {
  const from = legacyStyleOf(doc.passJson);
  if (from === style || style === 'posterGeneric') return doc;
  const next = copy(doc);
  const old = dictOf(next.passJson, 'legacy');
  delete next.passJson[from];
  delete next.passJson.posterGeneric;
  next.target = undefined;
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
  const dict = dictOf(next.passJson, next.target);
  if (value === undefined || value === '') delete dict[key];
  else dict[key] = value;
  next.passJson[styleOf(next.passJson, next.target)] = dict;
  return next;
}

/** A key like `field1`, unique across the pass. */
export function uniqueKey(pass: Dict, base = 'field'): string {
  const taken = new Set(everyKey(pass));
  let n = 1;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

function listOf(next: DesignDoc, group: GroupId): Dict[] {
  const style = styleOf(next.passJson, next.target);
  const dict = dictOf(next.passJson, next.target);
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
  const at = findField(doc.passJson, key, doc.target);
  if (!at) return doc;
  const next = copy(doc);
  listOf(next, at.group).splice(at.index, 1);
  next.manifest.bindings = dropFieldBindings(next.manifest, key);
  return next;
}

/** Moves a field to `index` of `group` (same or another group). */
export function moveField(doc: DesignDoc, key: string, group: GroupId, index: number): DesignDoc {
  const at = findField(doc.passJson, key, doc.target);
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
  const at = findField(doc.passJson, key, doc.target);
  if (!at) return doc;
  const to = at.index + delta;
  if (to < 0 || to >= fieldsOf(doc.passJson, at.group, doc.target).length) return doc;
  return moveField(doc, key, at.group, to);
}

export function updateField(doc: DesignDoc, key: string, patch: Dict): DesignDoc {
  const at = findField(doc.passJson, key, doc.target);
  if (!at) return doc;
  const next = copy(doc);
  const field = listOf(next, at.group)[at.index] as Dict;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete field[k];
    else field[k] = v;
  }
  return next;
}

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** The anchor of a static link; only https, tel and mailto targets become one. */
export function anchorOf(url: string): string {
  const text = escapeHtml(url);
  return /^(https:|tel:|mailto:)/i.test(url.trim()) ? `<a href="${text}">${text}</a>` : text;
}

/** Static text of a field; a link field's anchor follows it. */
export function setFieldValue(doc: DesignDoc, key: string, value: string): DesignDoc {
  const at = findField(doc.passJson, key, doc.target);
  const field = at ? fieldsOf(doc.passJson, at.group, doc.target)[at.index] : undefined;
  const link = field?.attributedValue !== undefined;
  return updateField(doc, key, {
    value,
    ...(link ? { attributedValue: anchorOf(value) } : {}),
  });
}

export function renameField(doc: DesignDoc, key: string, to: string): DesignDoc {
  if (key === to || to === '' || everyKey(doc.passJson).includes(to)) return doc;
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
  const at = findField(next.passJson, key, next.target);
  const field = at ? fieldsOf(next.passJson, at.group, next.target)[at.index] : undefined;
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
  const at = findField(doc.passJson, key, doc.target);
  if (!at) return doc;
  const next = copy(doc);
  const field = listOf(next, at.group)[at.index] as Dict;
  const source = fieldSource(next.manifest, key);
  if (on) {
    const url = typeof field.value === 'string' ? field.value : '';
    field.attributedValue = anchorOf(url);
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
