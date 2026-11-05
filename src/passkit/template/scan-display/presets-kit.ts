/**
 * The card catalogue (DM 1.7, 6.4): factories that write ordinary rows tagged with a `slot`.
 * After `build` a panel is plain data; rendering never reads the `preset` tag.
 */
import type { Json, PassJson, ScanPresetId, TemplateManifest } from '../../types.ts';
import type { ScanIconId } from './icons.ts';
import type { ScanPanelDoc } from './schema.ts';
import { type InputSchema, inputProps, isSecretInput, scanLevel } from './scope.ts';

export interface PresetSlot {
  name: string;
  accepts: 'text' | 'number' | 'date' | 'image' | 'history';
  /** Input names and `x-label`s, normalized, best first. They drive auto-mapping. */
  hints: string[];
  optional: boolean;
}

/** Slot to input name. The Details preset maps to full paths (`fields.seat`, `inputs.tier`). */
export type PresetMapping = Record<string, string>;

export interface PresetEnv {
  passJson?: PassJson;
  /** `en.lproj/pass.strings`, to turn a field's label key into words. */
  strings?: Record<string, string>;
}

export interface Preset {
  id: ScanPresetId;
  v: number;
  title: string;
  icon: ScanIconId;
  slots: PresetSlot[];
  /** The panel for this template. `mapping` overrides what auto-mapping found. */
  build(manifest: TemplateManifest, mapping?: PresetMapping, env?: PresetEnv): ScanPanelDoc;
}

export interface PresetDef extends Omit<Preset, 'build'> {
  make(manifest: TemplateManifest, mapping: PresetMapping, env: PresetEnv): ScanPanelDoc['rows'];
}

const norm = (value: unknown) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

function fits(accepts: PresetSlot['accepts'], schema: InputSchema): boolean {
  const type = schema.type;
  if (accepts === 'number') return type === 'number' || type === 'integer';
  if (accepts === 'date')
    return (
      schema.format === 'date' ||
      schema.format === 'date-time' ||
      schema['x-widget'] === 'date' ||
      schema['x-widget'] === 'datetime'
    );
  if (accepts === 'text') return type === undefined || type === 'string';
  return false;
}

/** Inputs a door scanner may show, in manifest order. */
function candidates(manifest: TemplateManifest): [string, InputSchema][] {
  return Object.entries(inputProps(manifest)).filter(
    ([name, schema]) => !isSecretInput(name, schema) && scanLevel(schema) !== 'hidden',
  );
}

/** Matches each slot's hints to an input, once per input. Slots with no match are left out. */
export function autoMap(manifest: TemplateManifest, slots: PresetSlot[]): PresetMapping {
  const found: PresetMapping = {};
  const used = new Set<string>();
  const pool = candidates(manifest);
  for (const slot of slots) {
    if (slot.accepts === 'history' || slot.accepts === 'image') continue;
    for (const hint of slot.hints) {
      const hit = pool.find(
        ([name, schema]) =>
          !used.has(name) &&
          fits(slot.accepts, schema) &&
          (norm(name) === hint || norm(schema['x-label']) === hint),
      );
      if (!hit) continue;
      found[slot.name] = hit[0];
      used.add(hit[0]);
      break;
    }
  }
  return found;
}

export function definePreset(def: PresetDef): Preset {
  const { make, ...meta } = def;
  return {
    ...meta,
    build(manifest, mapping = {}, env = {}) {
      return {
        id: `p_${def.id}`,
        preset: { id: def.id, v: def.v },
        title: def.title,
        icon: def.icon,
        rows: make(manifest, { ...autoMap(manifest, def.slots), ...mapping }, env),
      };
    },
  };
}

/** How many slots a preset finds in a template: the editor's "N found" badge. */
export const slotsFound = (manifest: TemplateManifest, preset: Preset): number =>
  Object.keys(autoMap(manifest, preset.slots)).length;

export const bind = (name: string, filter?: string): string =>
  `{{inputs.${name}${filter ? `|${filter}` : ''}}}`;

export const titleCase = (word: string): string =>
  word.charAt(0).toUpperCase() +
  word
    .slice(1)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();

/** The input the first add, take or set action changes, when it is a number. */
export function firstActionInput(manifest: TemplateManifest): string | null {
  const props = inputProps(manifest);
  for (const action of manifest.scan?.actions ?? [])
    if (['add', 'take', 'set'].includes(action.kind) && action.input && props[action.input])
      return action.input;
  return null;
}

/** Ids of the actions that change `input`, take and add first. */
export function actionsOn(manifest: TemplateManifest, input: string, kinds: string[]): string[] {
  return (manifest.scan?.actions ?? [])
    .filter((a) => a.input === input && kinds.includes(a.kind))
    .map((a) => a.id);
}

export type { Json };
