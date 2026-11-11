import { exprReferences } from '@/passkit/template/expr.ts';
import { condPaths } from '@/passkit/template/scan-display/condition.ts';
import { PRESETS } from '@/passkit/template/scan-display/presets.ts';
import type {
  ScanChipDoc,
  ScanDisplayDoc,
  ScanPanelDoc,
  ScanPresetId,
  ScanRowDoc,
  ScanText,
} from '@/passkit/template/scan-display/schema.ts';
import { inputProps } from '@/passkit/template/scan-display/scope.ts';
import { parseParts, splitPath } from '@/passkit/template/scan-display/text.ts';
import { sourcesOf, walkDoc } from '@/passkit/template/scan-display/walk.ts';
import type { ScanRole } from '@/passkit/types.ts';
import { type DesignDoc, isRecord } from '../model.ts';
import { safeScanExpression, scanBindingOptions } from './scan-fields.tsx';
import { allIds, copyRow, freshRow } from './scan-outline-ids.ts';
import {
  previewManifest,
  previewPassFields,
  previewSecrets,
  privatePreviewKey,
  safePreviewText,
} from './scan-preview-policy.ts';

type RowType = ScanRowDoc['type'];

export {
  allowedPaths,
  bindingDoc,
  chipName,
  holderIsName,
  labelText,
  normalPath,
  panelName,
  placementReason,
  reorder,
  replacePanel,
  resetPanel,
  safePreset,
  typedManifest,
  typedPass,
  withoutRefs,
};

const labelText = (text: ScanText | null | undefined, fallback: string) =>
  typeof text === 'string' && text && safePreviewText(text) ? text : fallback;
const panelName = (panel: ScanPanelDoc) =>
  labelText(panel.title, panel.preset ? PRESETS[panel.preset.id].title : 'Panel');
const chipName = (chip: ScanChipDoc, index: number) => labelText(chip.text, `Chip ${index + 1}`);
const typedManifest = (doc: DesignDoc) => previewManifest(doc);
const typedPass = (doc: DesignDoc) => previewPassFields(doc);

/** Only metadata reaches the pickers. A barcode-bound or private input is never offered. */
function bindingDoc(doc: DesignDoc): DesignDoc {
  const manifest = typedManifest(doc);
  const denied = previewSecrets(manifest);
  for (const name of Object.keys(inputProps(manifest)))
    if (privatePreviewKey(name)) denied.add(name);
  const deniedFields = new Set(denied);
  for (const binding of manifest.bindings) {
    if (
      !binding ||
      !isRecord(binding.to) ||
      !('field' in binding.to) ||
      binding.value === undefined
    )
      continue;
    try {
      if (exprReferences(binding.value).inputs.some((name) => denied.has(name)))
        for (const key of [binding.to.field].flat())
          if (typeof key === 'string') deniedFields.add(key);
    } catch {
      // A malformed binding cannot safely establish which field it reads.
      for (const key of [binding.to.field].flat())
        if (typeof key === 'string') deniedFields.add(key);
    }
  }
  const properties = Object.fromEntries(
    Object.entries(inputProps(manifest)).map(([name, schema]) => [
      name,
      denied.has(name) ? { ...schema, 'x-scan': 'hidden' } : schema,
    ]),
  );
  return {
    ...doc,
    manifest: { ...doc.manifest, inputs: { ...manifest.inputs, properties } },
    passJson: previewPassFields(doc, deniedFields) as unknown as DesignDoc['passJson'],
  };
}

function holderIsName(doc: DesignDoc, display: ScanDisplayDoc): boolean {
  const parts = display.holder ? parseParts(display.holder).parts : null;
  const part = parts?.length === 1 ? parts[0] : undefined;
  const split = part?.path && !part.filter ? splitPath(part.path) : null;
  if (split?.root === 'fields') return true;
  if (split?.root !== 'inputs') return false;
  const schema = inputProps(typedManifest(doc))[split.rest[0] ?? ''];
  return (
    !schema ||
    (schema.enum === undefined && (schema.type === undefined || schema.type === 'string'))
  );
}

const replacePanel = (doc: ScanDisplayDoc, panel: ScanPanelDoc): ScanDisplayDoc => ({
  ...doc,
  panels: (doc.panels ?? []).map((item) => (item.id === panel.id ? panel : item)),
});
function reorder<T>(list: readonly T[], from: number, to: number): T[] {
  const result = [...list];
  const [item] = result.splice(from, 1);
  if (item !== undefined) result.splice(to, 0, item);
  return result;
}
function withoutRefs(
  doc: ScanDisplayDoc,
  removed: readonly string[],
  panelId?: string,
): ScanDisplayDoc {
  if (!doc.customer) return doc;
  return {
    ...doc,
    customer: {
      ...doc.customer,
      ...(doc.customer.chips
        ? { chips: doc.customer.chips.filter((id) => !removed.includes(id)) }
        : {}),
      ...(panelId && doc.customer.panel === panelId ? { panel: null } : {}),
    },
  };
}

/** Reject moves that introduce a placement violation, while allowing repairs to existing drafts. */
function placement(doc: ScanDisplayDoc): Map<string, string> {
  const bad = new Map<string, string>();
  let histories = 0;
  for (const panel of doc.panels ?? []) {
    const counts: Partial<Record<RowType, number>> = {};
    panel.rows.forEach((row, index) => {
      counts[row.type] = (counts[row.type] ?? 0) + 1;
      if (row.type === 'image' && (index !== 0 || (counts.image ?? 0) > 1))
        bad.set(row.id, 'An image goes first in its panel, once.');
      if (
        row.type === 'divider' &&
        (index === 0 ||
          index === panel.rows.length - 1 ||
          panel.rows[index - 1]?.type === 'divider')
      )
        bad.set(row.id, 'A divider goes between two rows.');
      if (row.type === 'heading' && index === panel.rows.length - 1)
        bad.set(row.id, 'A heading needs a row after it.');
      if (
        (row.type === 'big' || row.type === 'money' || row.type === 'progress') &&
        (counts[row.type] ?? 0) > 2
      )
        bad.set(row.id, 'Use at most two of this value type in a panel.');
      if (row.type === 'history' && ++histories > 1)
        bad.set(row.id, 'Use one history row per result.');
    });
  }
  return bad;
}
function placementReason(before: ScanDisplayDoc, after: ScanDisplayDoc): string | null {
  const old = placement(before);
  for (const [id, message] of placement(after))
    if (!old.has(id) || old.get(id) !== message) return message;
  return null;
}

/** Paths offered by the shared picker are already secret-, barcode- and role-filtered. */
function allowedPaths(doc: DesignDoc, role: ScanRole = 'door'): Set<string> {
  const safe = bindingDoc(doc);
  return new Set(
    scanBindingOptions(safe.manifest, role, safe.passJson)
      .filter((option) => !option.disabled)
      .map((option) => option.value),
  );
}
function normalPath(path: string): string {
  const split = splitPath(path);
  return split?.root === 'inputs' && split.rest.length === 1 ? `inputs.${split.rest[0]}` : path;
}
function safeSlots(display: ScanDisplayDoc, paths: Set<string>): boolean {
  const slots = walkDoc(display);
  const options = [...paths].map((value) => ({ value, label: value }));
  const safe = (source: string) => safeScanExpression(source, options);
  return (
    slots.exprs.every((slot) => safe(slot.expr)) &&
    slots.texts.every(
      (slot) =>
        sourcesOf(slot.text).every(safe) &&
        (typeof slot.text === 'string' || safe(slot.text.count)),
    ) &&
    slots.conds.every((slot) => condPaths(slot.cond).every((path) => paths.has(normalPath(path))))
  );
}
function safePreset(
  doc: DesignDoc,
  id: ScanPresetId,
  mapping: Record<string, string> = {},
): ScanPanelDoc {
  const manifest = typedManifest(doc);
  const paths = allowedPaths(doc);
  const properties = Object.fromEntries(
    Object.entries(inputProps(manifest)).filter(([name]) => paths.has(`inputs.${name}`)),
  );
  const safeManifest = {
    ...manifest,
    inputs: { ...manifest.inputs, properties },
    ...(manifest.scan
      ? {
          scan: {
            ...manifest.scan,
            actions: (manifest.scan.actions ?? []).filter(
              (action) => !action.input || paths.has(`inputs.${action.input}`),
            ),
          },
        }
      : {}),
  };
  const built = PRESETS[id].build(safeManifest, mapping, { passJson: typedPass(doc) });
  const rows = built.rows.filter((row) =>
    safeSlots({ v: 1, header: {}, panels: [{ ...built, rows: [row] }] }, paths),
  );
  if (rows.length) return { ...built, rows };
  // Keep the preset's primitive editable even when its suggested binding is unavailable.
  const first = built.rows[0];
  const blank = freshRow(first?.type ?? 'field', new Set());
  return { ...built, rows: [{ ...blank, slot: first?.slot }] };
}
function recoverMapping(panel: ScanPanelDoc): Record<string, string> {
  const mapping: Record<string, string> = {};
  const preset = panel.preset?.id;
  if (!preset) return mapping;
  const slots = new Set(PRESETS[preset].slots.map((slot) => slot.name));
  const recover = (slot: string | undefined, value: ScanText | undefined) => {
    if (!slot || !slots.has(slot) || typeof value !== 'string') return;
    const match = /^\{\{\s*(inputs|fields)\.([\w-]+)(?:\|[^}]*)?\s*\}\}$/.exec(value);
    if (match?.[1] && match[2])
      mapping[slot] = preset === 'details' ? `${match[1]}.${match[2]}` : match[2];
  };
  for (const row of panel.rows) {
    if (!row.slot) continue;
    if (row.type === 'field' || row.type === 'big' || row.type === 'progress')
      recover(row.slot, row.value);
    else if (row.type === 'money') recover(row.slot, row.amount);
    else if (row.type === 'chips') recover(row.slot, row.items[0]?.text);
    else if (row.type === 'columns')
      for (const item of row.items) {
        const original = item.id.replace(/^i_/, '').replace(/_[a-z0-9]+$/, '');
        const label =
          typeof item.label === 'string' ? item.label.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
        const slot = slots.has(original)
          ? original
          : PRESETS[preset].slots.find(
              (entry) => entry.name.toLowerCase() === label || entry.hints.includes(label),
            )?.name;
        recover(slot, item.value);
      }
  }
  return mapping;
}
function resetPanel(
  doc: DesignDoc,
  display: ScanDisplayDoc,
  panel: ScanPanelDoc,
): ScanPanelDoc | null {
  if (!panel.preset) return null;
  const built = safePreset(doc, panel.preset.id, recoverMapping(panel));
  const kept = panel.rows.filter((row) => !row.slot);
  if (built.rows.length + kept.length > 6) return null;
  const used = allIds(display);
  return {
    ...panel,
    preset: built.preset,
    rows: [...built.rows.map((row) => copyRow(row, used)), ...kept],
  };
}
