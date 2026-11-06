/** Details and Note (DM 1.7). */
import { fieldLabel, frontFields } from './pass-fields.ts';
import { definePreset, type PresetEnv } from './presets-kit.ts';
import type { ScanRowDoc } from './schema.ts';
import { inputProps, isSecretInput } from './scope.ts';

const DETAIL_SLOTS = ['field1', 'field2', 'field3', 'field4'].map((name) => ({
  name,
  accepts: 'text' as const,
  hints: [],
  optional: true,
}));

/** Quick picks: the pass's front fields, else the first text inputs. Values are full paths. */
function picks(manifest: Parameters<typeof frontFields>[0], env: PresetEnv, max: number) {
  const fields = frontFields(manifest, env.passJson, env.strings).map((f) => ({
    path: `fields.${f.key}`,
    label: f.label,
  }));
  if (fields.length > 0) return fields.slice(0, max);
  return Object.entries(inputProps(manifest))
    .filter(
      ([name, schema]) =>
        !isSecretInput(name, schema) && (schema.type === undefined || schema.type === 'string'),
    )
    .slice(0, max)
    .map(([name, schema]) => ({
      path: `inputs.${name}`,
      label: fieldLabel(name, schema['x-label'] as string | undefined, env.strings),
    }));
}

export const details = definePreset({
  id: 'details',
  v: 1,
  title: 'Details',
  icon: 'info',
  slots: DETAIL_SLOTS,
  make(manifest, map, env) {
    const chosen = DETAIL_SLOTS.map((s) => map[s.name]).filter((p): p is string => Boolean(p));
    const rows: ScanRowDoc[] = [];
    if (chosen.length > 0) {
      const known = new Map(picks(manifest, env, 99).map((p) => [p.path, p.label]));
      for (const [i, path] of chosen.entries())
        rows.push({
          id: `r_field${i + 1}`,
          slot: `field${i + 1}`,
          type: 'field',
          label: known.get(path) ?? fieldLabel(path.split('.').pop() ?? '', undefined),
          value: `{{${path}}}`,
        });
      return rows;
    }
    for (const [i, pick] of picks(manifest, env, 4).entries())
      rows.push({
        id: `r_field${i + 1}`,
        slot: `field${i + 1}`,
        type: 'field',
        label: pick.label,
        value: `{{${pick.path}}}`,
      });
    if (rows.length === 0)
      rows.push({
        id: 'r_field1',
        slot: 'field1',
        type: 'field',
        label: 'Pass',
        value: '{{pass.title}}',
      });
    return rows;
  },
});

export const note = definePreset({
  id: 'note',
  v: 1,
  title: 'Note',
  icon: 'hand',
  slots: [{ name: 'text', accepts: 'text', hints: [], optional: false }],
  make: () => [{ id: 'r_note', slot: 'text', type: 'note', text: '', tone: 'info', icon: 'hand' }],
});
