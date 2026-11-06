/**
 * `defaultScanDisplay` (DM 2.2): what a template with no `scan.display` shows. Applied at read,
 * never stored, so a better default reaches every uncustomized template at once.
 */
import type { PassJson, ScanAction, TemplateManifest } from '../../types.ts';
import { exprReferences } from '../expr.ts';
import { DENSITY, rowUnits } from './density.ts';
import { truncate } from './format.ts';
import { frontFields, holderInput } from './pass-fields.ts';
import type { ScanDisplayDoc, ScanPanelDoc, ScanRowDoc } from './schema.ts';
import { actionGoals, inputProps } from './scope.ts';

const bind = (name: string) => `{{inputs.${name}}}`;

/** The first add or take action on a number input. */
function mainAction(manifest: TemplateManifest): (ScanAction & { input: string }) | null {
  const props = inputProps(manifest);
  for (const action of manifest.scan?.actions ?? []) {
    const type = action.input ? props[action.input]?.type : undefined;
    if (
      (action.kind === 'add' || action.kind === 'take') &&
      action.input &&
      (type === 'number' || type === 'integer')
    )
      return action as ScanAction & { input: string };
  }
  return null;
}

/** The currency a pass field bound to `input` shows, as a display expression. */
function currencyOf(manifest: TemplateManifest, input: string): string | null {
  const field = manifest.bindings.find(
    (b) =>
      'field' in b.to &&
      (b.to.prop === undefined || b.to.prop === 'value') &&
      typeof b.value === 'string' &&
      exprReferences(b.value).inputs.includes(input),
  );
  const key = field && 'field' in field.to ? field.to.field : null;
  const binding = manifest.bindings.find(
    (b) =>
      'field' in b.to &&
      b.to.prop === 'currencyCode' &&
      JSON.stringify(b.to.field) === JSON.stringify(key),
  );
  if (!binding || typeof binding.value !== 'string') return null;
  const lone = /^\{\{\s*([\w-]+)\s*\}\}$/.exec(binding.value);
  if (lone?.[1]) return bind(lone[1]);
  return /^[A-Z]{3}$/.test(binding.value) ? binding.value : null;
}

function actionPanel(manifest: TemplateManifest): ScanPanelDoc | null {
  const action = mainAction(manifest);
  if (!action) return null;
  const { input } = action;
  const schema = inputProps(manifest)[input] ?? {};
  const currency = currencyOf(manifest, input);
  let row: ScanRowDoc;
  if (currency) row = { id: 'r_main', type: 'money', amount: bind(input), currency };
  else if (actionGoals(manifest)[input]) {
    const taken = actionGoals(manifest)[input];
    row = {
      id: 'r_main',
      type: 'progress',
      value: bind(input),
      ...(taken?.reward ? { reward: taken.reward } : {}),
    };
  } else {
    const label =
      typeof schema['x-label'] === 'string' ? truncate(schema['x-label'], 12) : undefined;
    row = { id: 'r_main', type: 'big', value: bind(input), ...(label ? { unit: label } : {}) };
  }
  return { id: 'p_main', rows: [row] };
}

export function defaultScanDisplay(
  manifest: TemplateManifest,
  passJson?: PassJson,
  strings?: Record<string, string>,
): ScanDisplayDoc {
  const holder = holderInput(manifest);
  const panels: ScanPanelDoc[] = [];
  const main = actionPanel(manifest);
  if (main) panels.push(main);
  const used = main ? DENSITY.frame + main.rows.reduce((sum, r) => sum + rowUnits(r), 0) : 0;
  const room = Math.min(4, Math.floor(DENSITY.result - used - DENSITY.frame));
  const fields = room > 0 ? frontFields(manifest, passJson, strings).slice(0, room) : [];
  if (fields.length > 0)
    panels.push({
      id: 'p_details',
      title: 'Details',
      icon: 'info',
      rows: fields.map((f, i) => ({
        id: `r_field${i + 1}`,
        type: 'field',
        label: f.label,
        value: `{{fields.${f.key}}}`,
      })),
    });
  return {
    v: 1,
    holder: holder ? bind(holder) : '{{pass.title}}',
    header: {},
    ...(panels.length > 0 ? { panels } : {}),
  };
}
