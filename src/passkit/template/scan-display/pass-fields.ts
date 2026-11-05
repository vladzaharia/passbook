/** The pass's front fields as the Details card and the default display use them (DM 1.7, 2.2). */
import type { Json, PassJson, TemplateManifest } from '../../types.ts';
import { PASS_STYLES } from '../../types.ts';
import { exprReferences } from '../expr.ts';
import { truncate } from './format.ts';
import { hiddenFieldKeys, inputProps } from './scope.ts';

export interface FrontField {
  key: string;
  label: string;
}

const FRONT_GROUPS = ['primaryFields', 'secondaryFields', 'auxiliaryFields'] as const;
const HOLDER_NAMES = ['holder', 'attendee', 'memberName', 'name', 'passenger'] as const;

/** The first of the usual name inputs that is a text input, for the holder line. */
export function holderInput(manifest: TemplateManifest): string | null {
  const props = inputProps(manifest);
  for (const name of HOLDER_NAMES) {
    const schema = props[name];
    if (schema && (schema.type === undefined || schema.type === 'string')) return name;
  }
  return null;
}

const humanize = (key: string) => {
  const words = key
    .replace(/-poster$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The label as Wallet shows it: a strings key resolves, a missing label becomes words. */
export function fieldLabel(key: string, label: Json | undefined, strings?: Record<string, string>) {
  const raw = typeof label === 'string' && label !== '' ? label : null;
  return truncate(raw ? (strings?.[raw] ?? raw) : humanize(key), 20);
}

/** Front fields in primary, secondary, auxiliary order; never the holder's name or a secret. */
export function frontFields(
  manifest: TemplateManifest,
  passJson: PassJson | undefined,
  strings?: Record<string, string>,
): FrontField[] {
  if (!passJson) return [];
  const style = PASS_STYLES.find((s) => (passJson as Record<string, unknown>)[s]);
  const block = style
    ? ((passJson as Record<string, unknown>)[style] as Record<string, unknown>)
    : null;
  if (!block) return [];
  const hidden = hiddenFieldKeys(manifest, passJson);
  const holder = holderInput(manifest);
  const holderFields = new Set<string>();
  for (const binding of manifest.bindings ?? []) {
    if (!('field' in binding.to) || typeof binding.value !== 'string') continue;
    const reads = exprReferences(binding.value).inputs;
    if (holder && reads.length === 1 && reads[0] === holder)
      for (const key of [binding.to.field].flat()) holderFields.add(key);
  }
  const out: FrontField[] = [];
  for (const group of FRONT_GROUPS) {
    const fields = block[group];
    if (!Array.isArray(fields)) continue;
    for (const field of fields as { key?: string; label?: Json }[]) {
      if (!field.key || hidden.has(field.key) || holderFields.has(field.key)) continue;
      out.push({ key: field.key, label: fieldLabel(field.key, field.label, strings) });
    }
  }
  return out;
}
