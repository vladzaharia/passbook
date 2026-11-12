import type { AssetEntry, PassJson } from '../../../passkit/types.ts';
import type { ReleaseChange, TemplateReleaseImpact } from '../../../shared/contracts/index.ts';

type Diff = TemplateReleaseImpact['diff'];
type Side = { label: string | null; value: string };

const FIELD_AREAS = [
  ['headerFields', 'Header'],
  ['primaryFields', 'Primary'],
  ['secondaryFields', 'Secondary'],
  ['auxiliaryFields', 'Auxiliary'],
  ['backFields', 'Back'],
] as const;
const STYLES = [
  'generic',
  'posterGeneric',
  'storeCard',
  'coupon',
  'eventTicket',
  'boardingPass',
] as const;
const COLORS = [
  ['backgroundColor', 'Background'],
  ['foregroundColor', 'Text'],
  ['labelColor', 'Labels'],
  ['stripColor', 'Strip'],
  ['footerBackgroundColor', 'Footer'],
] as const;
const MAX_CHANGES = 50;

const text = (value: unknown): string =>
  typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);

function change(label: string, from: string | null, to: string | null): ReleaseChange {
  return { label, kind: from === null ? 'added' : to === null ? 'removed' : 'changed', from, to };
}

/** Fields are keyed by area and their stable key; the label is shown, and a label edit is its own change. */
function fieldMap(pass: PassJson): Map<string, Side & { name: string }> {
  const out = new Map<string, Side & { name: string }>();
  for (const style of STYLES) {
    const fields = pass[style] as Record<string, unknown> | undefined;
    if (!fields) continue;
    for (const [area, name] of FIELD_AREAS) {
      const list = fields[area];
      if (!Array.isArray(list)) continue;
      for (const f of list as { key?: string; label?: unknown; value?: unknown }[])
        if (f.key) {
          const label = typeof f.label === 'string' && f.label ? f.label : null;
          out.set(`${area}:${f.key}`, {
            name: `${name}: ${label ?? f.key}`,
            label,
            value: text(f.value),
          });
        }
    }
  }
  return out;
}

function fieldChanges(a: PassJson | null, b: PassJson): ReleaseChange[] {
  const before = a ? fieldMap(a) : new Map<string, Side & { name: string }>();
  const after = fieldMap(b);
  const out: ReleaseChange[] = [];
  for (const [key, now] of after) {
    const was = before.get(key);
    if (!was) out.push(change(now.name, null, now.value));
    else {
      if (was.value !== now.value) out.push(change(now.name, was.value, now.value));
      if (was.label !== now.label)
        out.push(change(`${now.name} (label)`, was.label ?? '', now.label ?? ''));
    }
  }
  for (const [key, was] of before) if (!after.has(key)) out.push(change(was.name, was.value, null));
  return out;
}

const imageSize = (a: AssetEntry) =>
  a.width && a.height ? `${a.width}×${a.height}` : `${a.size} bytes`;

function imageChanges(a: AssetEntry[] | null, b: AssetEntry[]): ReleaseChange[] {
  const isImage = (e: AssetEntry) => e.slot !== 'strings' && e.slot !== 'other';
  const before = new Map((a ?? []).filter(isImage).map((e) => [e.name, e]));
  const after = new Map(b.filter(isImage).map((e) => [e.name, e]));
  const out: ReleaseChange[] = [];
  for (const [name, now] of after) {
    const was = before.get(name);
    if (!was) out.push(change(name, null, imageSize(now)));
    else if (was.sha1 !== now.sha1) out.push(change(name, imageSize(was), imageSize(now)));
  }
  for (const [name, was] of before)
    if (!after.has(name)) out.push(change(name, imageSize(was), null));
  return out;
}

function barcodesOf(pass: PassJson | null): Record<string, string>[] {
  const list = pass?.barcodes ?? (pass?.barcode ? [pass.barcode] : []);
  return list.map((code) => ({
    Format: text(code.format),
    Message: text(code.message),
    'Alt text': text(code.altText),
    Encoding: text(code.messageEncoding),
  }));
}

function barcodeChanges(a: PassJson | null, b: PassJson): ReleaseChange[] {
  const before = barcodesOf(a);
  const after = barcodesOf(b);
  const many = Math.max(before.length, after.length) > 1;
  const out: ReleaseChange[] = [];
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    const was = before[i];
    const now = after[i];
    const prefix = many ? `Barcode ${i + 1}: ` : '';
    if (!was && now)
      out.push(change(`${prefix || 'Barcode'}${many ? 'Format' : ''}`, null, now.Format ?? ''));
    else if (was && !now)
      out.push(change(`${prefix || 'Barcode'}${many ? 'Format' : ''}`, was.Format ?? '', null));
    else if (was && now)
      for (const [key, value] of Object.entries(now))
        if (was[key] !== value)
          out.push(change(`${prefix}${key}`, was[key] || null, value || null));
  }
  return out;
}

/** `rgb(1,2,3)`, `rgb(1, 2, 3)` and `#010203` are the same colour. */
export function normalizeColor(value: string): string {
  const v = value.trim().toLowerCase().replace(/\s+/g, '');
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    const n = (i: number) => Number.parseInt(full.slice(i, i + 2), 16);
    return `rgb(${n(0)},${n(2)},${n(4)})`;
  }
  return v;
}

function colorChanges(a: PassJson | null, b: PassJson): ReleaseChange[] {
  return COLORS.flatMap(([key, label]) => {
    const was = typeof a?.[key] === 'string' ? (a[key] as string) : null;
    const now = typeof b[key] === 'string' ? (b[key] as string) : null;
    const same =
      was === now || (was !== null && now !== null && normalizeColor(was) === normalizeColor(now));
    return same ? [] : [change(label, was, now)];
  });
}

/** What changes between two versions of a pass: fields, images, barcode and colours. `from` null: no release yet. */
export function versionDiff(
  from: { passJson: PassJson; assets: AssetEntry[] } | null,
  to: { passJson: PassJson; assets: AssetEntry[] },
): { diff: Diff; more: TemplateReleaseImpact['more'] } {
  const lists = {
    fields: fieldChanges(from?.passJson ?? null, to.passJson),
    images: imageChanges(from?.assets ?? null, to.assets),
    barcode: barcodeChanges(from?.passJson ?? null, to.passJson),
    colors: colorChanges(from?.passJson ?? null, to.passJson),
  };
  const more = (list: ReleaseChange[]) => Math.max(0, list.length - MAX_CHANGES);
  return {
    diff: {
      fields: lists.fields.slice(0, MAX_CHANGES),
      images: lists.images.slice(0, MAX_CHANGES),
      barcode: lists.barcode.slice(0, MAX_CHANGES),
      colors: lists.colors.slice(0, MAX_CHANGES),
    },
    more: {
      fields: more(lists.fields),
      images: more(lists.images),
      barcode: more(lists.barcode),
      colors: more(lists.colors),
    },
  };
}
