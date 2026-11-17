import { GOAL_MAX, GOAL_MIN, stampGrid } from '@/passkit/stamps/layout.ts';
import { maxStamps } from '@/passkit/stamps/rules.ts';
import type { DesignDoc, DraftAsset } from './model.ts';
import { type Dict, isRecord } from './model.ts';

export { GOAL_MAX, GOAL_MIN };

export type ArtSlot = 'filled' | 'empty' | 'reward' | 'rewardEarned';

export const ART_SLOTS: readonly {
  slot: ArtSlot;
  label: string;
  optional: boolean;
  file: string;
}[] = [
  { slot: 'filled', label: 'Filled stamp', optional: false, file: 'stamps/filled.png' },
  { slot: 'empty', label: 'Empty stamp', optional: false, file: 'stamps/empty.png' },
  { slot: 'reward', label: 'Reward', optional: true, file: 'stamps/reward.png' },
  {
    slot: 'rewardEarned',
    label: 'Reward earned',
    optional: true,
    file: 'stamps/reward-earned.png',
  },
];

export const ART_HINT = 'Square PNG, 256 px or more. Keep the stamp in the middle two thirds.';
export const STRIP_STYLES = ['storeCard', 'coupon', 'eventTicket'] as const;

export interface StampsView {
  input: string;
  goal: number;
  tilt: boolean;
  keepReady: boolean;
  art: Partial<Record<ArtSlot, string>>;
}

export function readStamps(doc: Pick<DesignDoc, 'manifest'>): StampsView | null {
  const s = doc.manifest.stamps;
  if (!isRecord(s)) return null;
  const art = isRecord(s.art) ? s.art : {};
  return {
    input: typeof s.input === 'string' ? s.input : 'stamps',
    goal: typeof s.goal === 'number' ? s.goal : 10,
    tilt: s.tilt !== false,
    keepReady: s.keepReady === true,
    art: Object.fromEntries(
      ART_SLOTS.filter(({ slot }) => typeof art[slot] === 'string').map(({ slot }) => [
        slot,
        art[slot],
      ]),
    ) as StampsView['art'],
  };
}

/** "2 rows of 4, 44 pt stamps" from the layout the strip will use. */
export function gridNote(goal: number): string {
  const { rows, d } = stampGrid(goal);
  const size = `${Math.round(d)} pt stamps`;
  const same = rows.every((n) => n === rows[0]);
  if (rows.length === 1) return `1 row of ${rows[0]}, ${size}`;
  return same
    ? `${rows.length} rows of ${rows[0]}, ${size}`
    : `${rows.length} rows of ${rows.join(', ')}, ${size}`;
}

/** What the input holds: a full card plus the carry-over. */
export const holdsNote = (goal: number): string =>
  `Holds up to ${maxStamps(goal)}: a full card plus ${goal - 1} saved.`;

const STAMP_HEADER_BINDINGS = (): Dict[] => [
  { to: { field: 'stamps' }, value: '{{pass.stamps.card}} of {{pass.stamps.goal}}' },
  {
    to: { field: 'stamps' },
    value: 'Reward ready',
    when: { input: 'pass.stamps.ready', eq: true },
  },
  {
    to: { field: 'stamps', prop: 'changeMessage' },
    value: '%@',
    when: { input: 'pass.stamps.ready', eq: true },
  },
];

const withoutAsset = (assets: readonly DraftAsset[], name: string) =>
  assets.filter((a) => a.name !== name);

/** Creates the block: goal 10, the count input, the header bindings and the given art. */
export function addStamps(doc: DesignDoc, art: Partial<Record<ArtSlot, DraftAsset>>): DesignDoc {
  if (doc.manifest.stamps) return doc;
  const goal = 10;
  const manifest = structuredClone(doc.manifest) as Dict;
  const passJson = structuredClone(doc.passJson) as Dict;
  const inputs = isRecord(manifest.inputs) ? manifest.inputs : { type: 'object' };
  const properties = isRecord(inputs.properties) ? { ...inputs.properties } : {};
  properties.stamps ??= {
    type: 'integer',
    minimum: 0,
    maximum: maxStamps(goal),
    default: 0,
    'x-label': 'Stamps',
    'x-order': 40,
    'x-help': `Redeeming takes ${goal} off. Extra stamps carry over.`,
  };
  manifest.inputs = { ...inputs, properties };
  manifest.sample = { ...(isRecord(manifest.sample) ? manifest.sample : {}), stamps: 0 };
  const style = ['storeCard', 'coupon', 'eventTicket'].find((s) => isRecord(passJson[s]));
  if (style) {
    const dict = passJson[style] as Dict;
    const header = Array.isArray(dict.headerFields) ? [...dict.headerFields] : [];
    if (!header.some((f) => isRecord(f) && f.key === 'stamps'))
      header.push({ key: 'stamps', label: 'Stamps', value: '' });
    dict.headerFields = header;
  }
  const bindings = Array.isArray(manifest.bindings) ? [...manifest.bindings] : [];
  manifest.bindings = [...STAMP_HEADER_BINDINGS(), ...bindings];
  const names: Dict = {};
  let assets = [...doc.assets];
  for (const { slot, file } of ART_SLOTS) {
    const asset = art[slot];
    if (!asset) continue;
    names[slot] = file;
    assets = [...withoutAsset(assets, file), { ...asset, name: file, slot: 'source', scale: 1 }];
  }
  manifest.stamps = { input: 'stamps', goal, art: names, tilt: true };
  return { passJson, manifest, assets };
}

/** A new goal: rewrites the block and the input's maximum, clamps the sample, drops keepReady. */
export function setGoal(doc: DesignDoc, goal: number): DesignDoc {
  const view = readStamps(doc);
  if (!view || goal < GOAL_MIN || goal > GOAL_MAX || goal === view.goal) return doc;
  const manifest = structuredClone(doc.manifest) as Dict;
  const { keepReady: _keep, ...block } = manifest.stamps as Dict;
  manifest.stamps = { ...block, goal };
  const inputs = manifest.inputs as Dict;
  const properties = inputs.properties as Dict;
  const node = properties[view.input];
  const max = maxStamps(goal);
  if (isRecord(node)) {
    node.maximum = max;
    if (typeof node['x-help'] === 'string')
      node['x-help'] = node['x-help'].replace(/takes \d+ off/, `takes ${goal} off`);
  }
  const sample = manifest.sample as Dict;
  if (typeof sample[view.input] === 'number')
    sample[view.input] = Math.min(sample[view.input] as number, max);
  return { ...doc, manifest };
}

export function setStampsProp(
  doc: DesignDoc,
  patch: { tilt?: boolean; keepReady?: boolean; maximum?: number },
) {
  if (!readStamps(doc)) return doc;
  const manifest = structuredClone(doc.manifest) as Dict;
  const block = { ...(manifest.stamps as Dict) };
  if (patch.tilt !== undefined) {
    if (patch.tilt) delete block.tilt;
    else block.tilt = false;
  }
  if (patch.keepReady !== undefined) {
    if (patch.keepReady) block.keepReady = true;
    else delete block.keepReady;
  }
  manifest.stamps = block;
  const view = readStamps(doc);
  const node = (manifest.inputs as Dict | undefined)?.properties as Dict | undefined;
  const input = view ? node?.[view.input] : undefined;
  if (patch.maximum !== undefined && isRecord(input)) input.maximum = patch.maximum;
  return { ...doc, manifest };
}

/** Puts one art file in its slot (null empties an optional slot). */
export function setArt(doc: DesignDoc, slot: ArtSlot, asset: DraftAsset | null): DesignDoc {
  const view = readStamps(doc);
  const def = ART_SLOTS.find((s) => s.slot === slot);
  if (!view || !def) return doc;
  const manifest = structuredClone(doc.manifest) as Dict;
  const block = manifest.stamps as Dict;
  const art = { ...(isRecord(block.art) ? block.art : {}) };
  if (asset) art[slot] = def.file;
  else delete art[slot];
  manifest.stamps = { ...block, art };
  const rest = withoutAsset(doc.assets, def.file);
  return {
    ...doc,
    manifest,
    assets: asset ? [...rest, { ...asset, name: def.file, slot: 'source', scale: 1 }] : rest,
  };
}

/** Whole-number inputs a card can count from, by label. */
export function countInputs(manifest: Dict): { value: string; label: string }[] {
  const inputs = isRecord(manifest.inputs) ? manifest.inputs : {};
  const props = isRecord(inputs.properties) ? inputs.properties : {};
  return Object.entries(props).flatMap(([name, schema]) =>
    isRecord(schema) && schema.type === 'integer'
      ? [{ value: name, label: typeof schema['x-label'] === 'string' ? schema['x-label'] : name }]
      : [],
  );
}

/** Counts from another whole-number input; it starts at 0 and holds a full card plus carry-over. */
export function setStampsInput(doc: DesignDoc, name: string): DesignDoc {
  const view = readStamps(doc);
  if (!view || view.input === name || !countInputs(doc.manifest).some((i) => i.value === name))
    return doc;
  const manifest = structuredClone(doc.manifest) as Dict;
  manifest.stamps = { ...(manifest.stamps as Dict), input: name };
  const node = ((manifest.inputs as Dict).properties as Dict)[name] as Dict;
  node.minimum = 0;
  if (typeof node.maximum !== 'number' || node.maximum < view.goal)
    node.maximum = maxStamps(view.goal);
  return { ...doc, manifest };
}

/** The stamps input was renamed in the inputs section: the block follows. */
export function renameStampsInput(doc: DesignDoc, from: string, to: string): DesignDoc {
  const view = readStamps(doc);
  if (!view || view.input !== from) return doc;
  const manifest = structuredClone(doc.manifest) as Dict;
  manifest.stamps = { ...(manifest.stamps as Dict), input: to };
  return { ...doc, manifest };
}

/** The sample count, clamped to the goal: where the preview slider starts. */
export function sampleCount(doc: DesignDoc): number {
  const view = readStamps(doc);
  const sample = isRecord(doc.manifest.sample) ? doc.manifest.sample : {};
  const n = view ? sample[view.input] : 0;
  return view ? Math.max(0, Math.min(typeof n === 'number' ? n : 0, view.goal)) : 0;
}
