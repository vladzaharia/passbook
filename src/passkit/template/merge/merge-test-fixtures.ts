import type { Json } from '../../types.ts';
import { mergePackages } from './apply.ts';
import { sha1Hex } from './sha1.ts';
import { writeStrings } from './strings.ts';
import type { MergeResult, PackageDoc } from './types.ts';

const enc = (s: string) => new TextEncoder().encode(s);
export const sha = (s: string) => sha1Hex(enc(s));
export const stringsFile = (values: Record<string, string>) => {
  const bytes = writeStrings(values);
  return { sha1: sha1Hex(bytes), bytes };
};

// biome-ignore lint/suspicious/noExplicitAny: fixtures edit untyped JSON
type Any = Record<string, any>;

/** A small card with every part the merge knows. */
export function baseDoc(): PackageDoc {
  return {
    passJson: {
      formatVersion: 1,
      organizationName: 'Org',
      description: 'Card',
      foregroundColor: 'rgb(0, 0, 0)',
      semantics: { balance: 1 },
      barcodes: [{ format: 'PKBarcodeFormatQR', message: 'm', messageEncoding: 'iso-8859-1' }],
      locations: [{ latitude: 1, longitude: 2 }],
      featuredActions: [{ identifier: 'call', title: 'Call' }],
      generic: {
        primaryFields: [{ key: 'name', label: 'Name', value: '' }],
        secondaryFields: [
          { key: 'tier', label: 'Tier', value: '' },
          { key: 'pts', label: 'Points', value: '' },
          { key: 'since', label: 'Since', value: '' },
        ],
        backFields: [{ key: 'terms', label: 'Terms', value: '' }],
      },
    },
    manifest: {
      schema: 1,
      name: 'Base',
      description: 'A card.',
      inputs: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', 'x-label': 'Name', maxLength: 40 },
          tier: { type: 'string', enum: ['a', 'b'], 'x-enumLabels': { a: 'A', b: 'B' } },
          pts: { type: 'integer', minimum: 0 },
        },
      },
      sample: { name: 'Ada' },
      lookups: { tiers: { a: { label: 'Alpha' } } },
      bindings: [
        { to: { field: 'name' }, value: '{{name}}' },
        { to: { field: 'tier' }, value: '{{tier}}' },
        { to: { field: 'pts' }, value: '{{pts}}' },
      ],
      display: { title: '{{name}}', subtitle: '{{tier}}', search: ['name'] },
      behaviors: [{ use: 'tiers', version: 1, config: { table: 'tiers' } }],
      requires: { styles: ['generic'] },
      previewOnlyAssets: ['preview.png'],
      scan: {
        actions: [
          { id: 'add', label: 'Add', kind: 'add', input: 'pts', amount: 1 },
          { id: 'take', label: 'Take', kind: 'take', input: 'pts', amount: 1 },
        ],
        lookup: { input: 'name' },
        flags: [{ input: 'tier', label: 'VIP', equals: ['a'] }],
        display: {
          v: 1,
          holder: '{{name}}',
          header: { title: '{{name}}', chips: [{ id: 'c1', text: 'Tier' }] },
          variants: [
            { id: 'v1', name: 'Gold', when: { input: 'tier', eq: 'a' }, header: { title: 'Gold' } },
          ],
          panels: [
            {
              id: 'p1',
              title: 'Card',
              actions: ['add'],
              rows: [
                { id: 'r1', type: 'note', text: 'Hello' },
                {
                  id: 'r2',
                  type: 'columns',
                  items: [
                    { id: 'i1', label: 'A', value: '1' },
                    { id: 'i2', label: 'B', value: '2' },
                  ],
                },
              ],
            },
          ],
          customer: { greet: true, chips: ['c1'], panel: 'p1' },
        },
        access: {
          input: { plan: 'tier' },
          plans: [
            { id: 'gold', label: 'Gold', kind: 'always', zones: [{ zone: 'a' }, { zone: 'b' }] },
          ],
          rules: { visitGapMinutes: 5 },
        },
      },
      nfc: { message: 'x' },
      stamps: {
        input: 'pts',
        goal: 10,
        art: { filled: 'stamps/filled.png', empty: 'stamps/empty.png' },
        tilt: true,
      },
      wallets: { schema: 1, required: [], google: { omit: ['a'], images: {} } },
    } as never,
    files: {
      'icon@2x.png': { sha1: sha('icon2') },
      'icon@3x.png': { sha1: sha('icon3') },
      'logo@2x.png': { sha1: sha('logo2') },
      'de.lproj/logo@2x.png': { sha1: sha('delogo2') },
      'stamps/filled.png': { sha1: sha('filled') },
      'stamps/empty.png': { sha1: sha('empty') },
      'stamps/strips/1/strip@2x.png': { sha1: sha('strip') },
      'wallets/google/hero.png': { sha1: sha('hero') },
      'en.lproj/pass.strings': stringsFile({ Name: 'Name', Tier: 'Tier' }),
      'personalization.json': {
        sha1: sha('p'),
        bytes: enc(JSON.stringify({ description: 'd', requiredPersonalizationFields: ['a'] })),
      },
    },
  };
}

/** A deep copy with `fn` applied; `fn` mutates `doc.passJson`, `doc.manifest`, `doc.files`. */
export function edit(doc: PackageDoc, fn?: (d: Any) => void): PackageDoc {
  const copy = {
    passJson: structuredClone(doc.passJson),
    manifest: structuredClone(doc.manifest),
    files: { ...doc.files },
  };
  fn?.(copy as unknown as Any);
  return copy;
}

/** Merges base with ours = base + `o` and theirs = base + `t`. */
export function run(o?: (d: Any) => void, t?: (d: Any) => void, twoWay = false): MergeResult {
  const base = baseDoc();
  return mergePackages(twoWay ? null : base, edit(base, o), edit(base, t));
}

export const ids = (r: MergeResult) => r.conflicts.map((c) => c.id);
export const kinds = (r: MergeResult) => Object.fromEntries(r.conflicts.map((c) => [c.id, c.kind]));
export const style = (r: MergeResult) => (r.merged.passJson as Any).generic as Any;
export const man = (r: MergeResult) => r.merged.manifest as unknown as Any;
export type { Any, Json };
