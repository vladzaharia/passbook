import { evaluate } from '@/passkit/template/expr.ts';
import { defaultScanDisplay } from '@/passkit/template/scan-display/defaults.ts';
import {
  DENSITY,
  headerCost,
  panelUnits,
  screenUnits,
  titlesOf,
  titleTwoLines,
} from '@/passkit/template/scan-display/density.ts';
import {
  type RenderScanDisplayOptions,
  renderScanDisplay,
} from '@/passkit/template/scan-display/render.ts';
import { sampleScope } from '@/passkit/template/scan-display/sample.ts';
import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import { hiddenFieldKeys, inputVisibleTo } from '@/passkit/template/scan-display/scope.ts';
import type { ScanDisplayScope } from '@/passkit/template/scan-display/text.ts';
import type { Json, ScanAction, ScanRole, TemplateManifest } from '@/passkit/types.ts';
import type { ScanDisplay, ScanDisplayScreen } from '@/shared/contracts/scan-display.ts';
import { DEFAULT_SCAN_ACTION, scanOf } from '@/shared/scan-defaults.ts';
import type { DesignDoc } from '../model.ts';
import {
  clean,
  filteredInputs,
  obj,
  previewManifest,
  previewPassFields,
  privateExpression,
  privatePreviewKey,
  safePreviewText,
} from './scan-preview-policy.ts';

export {
  hasUnsafeRenderedText,
  previewPassFields,
} from './scan-preview-policy.ts';

export function syntheticScope(
  doc: DesignDoc,
  role: ScanRole,
  now: number,
  overrides: Record<string, Json> = {},
): ScanDisplayScope {
  const manifest = previewManifest(doc);
  // Defaults and overrides follow the same policy; denied properties are never dereferenced.
  const policy = filteredInputs(manifest, role, manifest.sample, overrides, true);
  const inputs = (clean(policy.values, policy.deniedKeys) ?? {}) as Record<string, Json>;
  const safeProps = Object.fromEntries(
    Object.entries(policy.props)
      .filter(
        ([key, schema]) =>
          !privatePreviewKey(key) && inputVisibleTo(key, schema, role, policy.secrets),
      )
      .map(([key, schema]) => {
        const copy = { ...schema };
        delete copy.default;
        return [key, copy] as const;
      }),
  );
  // A lookup can contain an unattributed copy of a protected value. Do not inspect it in that case.
  const lookups = (
    policy.restricted ? {} : (clean((manifest.lookups ?? {}) as Json, policy.deniedKeys) ?? {})
  ) as NonNullable<TemplateManifest['lookups']>;
  const safeDisplay = {
    title:
      privateExpression(manifest.display.title, policy.deniedKeys) ||
      (policy.restricted &&
        (typeof manifest.display.title !== 'string' || !manifest.display.title.includes('{{')))
        ? manifest.name
        : manifest.display.title,
    ...(manifest.display.subtitle !== undefined &&
    !privateExpression(manifest.display.subtitle, policy.deniedKeys) &&
    (!policy.restricted ||
      (typeof manifest.display.subtitle === 'string' && manifest.display.subtitle.includes('{{')))
      ? { subtitle: manifest.display.subtitle }
      : {}),
  };
  const safeManifest: TemplateManifest = {
    ...manifest,
    inputs: { type: 'object', properties: safeProps },
    sample: inputs,
    display: safeDisplay,
    lookups,
  };
  const scope = sampleScope(safeManifest, { now, scanner: { name: 'Sample scanner', role } });
  const fields: Record<string, Json> = {};
  const hidden = hiddenFieldKeys(
    manifest,
    undefined,
    new Set([...policy.secrets, ...policy.deniedKeys]),
  );
  for (const binding of manifest.bindings) {
    if (
      !('field' in binding.to) ||
      (binding.to.prop !== undefined && binding.to.prop !== 'value') ||
      binding.value === undefined ||
      privateExpression(binding.value, policy.deniedKeys)
    )
      continue;
    if (policy.restricted && (typeof binding.value !== 'string' || !binding.value.includes('{{')))
      continue;
    try {
      const value = clean(evaluate(binding.value, { input: inputs, lookups }), policy.deniedKeys);
      if (value === undefined || (typeof value === 'object' && value !== null)) continue;
      for (const key of [binding.to.field].flat())
        if (!hidden.has(key) && !privatePreviewKey(key)) fields[key] = value;
    } catch {
      /* An incomplete binding is reported by validation, not painted. */
    }
  }
  scope.fields = fields;
  scope.previewRestricted = policy.restricted;
  return (clean(scope as Json, policy.deniedKeys) ?? {}) as ScanDisplayScope;
}

export function safeRealScope(
  doc: DesignDoc,
  role: ScanRole,
  scope: ScanDisplayScope,
): ScanDisplayScope {
  const manifest = previewManifest(doc);
  const policy = filteredInputs(manifest, role, obj(scope.inputs) ?? {});
  const inputs = (clean(policy.values, policy.deniedKeys) ?? {}) as Record<string, Json>;
  const hidden = hiddenFieldKeys(
    manifest,
    undefined,
    new Set([...policy.secrets, ...policy.deniedKeys]),
  );
  for (const binding of manifest.bindings) {
    if ('field' in binding.to && privateExpression(binding.value, policy.deniedKeys)) {
      for (const key of [binding.to.field].flat()) hidden.add(key);
    }
  }
  const fields = obj(scope.fields);
  if (fields && [...hidden].some((key) => Object.hasOwn(fields, key))) policy.restricted = true;
  for (const key of hidden) policy.deniedKeys.add(key);
  if (policy.restricted) {
    // A newer draft can classify data that the active server version allowed. The remaining
    // projections, history, assets and lookups may contain copies, so rebuild only safe identity.
    const pass: Record<string, Json> = { templateName: manifest.name };
    for (const [key, expr] of [
      ['title', manifest.display.title],
      ['subtitle', manifest.display.subtitle],
    ] as const) {
      if (
        expr === undefined ||
        privateExpression(expr, policy.deniedKeys) ||
        typeof expr !== 'string' ||
        !expr.includes('{{')
      )
        continue;
      try {
        const value = clean(evaluate(expr, { input: inputs, lookups: {} }), policy.deniedKeys);
        if (typeof value === 'string' && value) pass[key] = value;
      } catch {
        /* An incomplete projection is not previewable. */
      }
    }
    return {
      inputs,
      fields: {},
      pass,
      scanner: { name: 'Preview scanner', role },
      lookups: {},
      assets: {},
    };
  }
  const pass = obj(clean(scope.pass, policy.deniedKeys)) ?? {};
  if (privateExpression(manifest.display.title, policy.deniedKeys)) delete pass.title;
  if (privateExpression(manifest.display.subtitle, policy.deniedKeys)) delete pass.subtitle;
  const result: ScanDisplayScope = { inputs, pass };
  for (const key of Object.keys(scope)) {
    if (
      key === 'inputs' ||
      key === 'pass' ||
      privatePreviewKey(key) ||
      policy.deniedKeys.has(key) ||
      !safePreviewText(key)
    )
      continue;
    const value = clean(scope[key], policy.deniedKeys);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function previewActions(manifest: TemplateManifest): ScanAction[] {
  const actions =
    Array.isArray(manifest.scan?.actions) && manifest.scan.actions.length
      ? manifest.scan.actions
      : [DEFAULT_SCAN_ACTION];
  return scanOf({ scan: { ...manifest.scan, actions } }).actions;
}

/** Add only system-owned simulated scan facts; pass data stays inside the renderer scope. */
export function scopeForOutcome(
  scope: ScanDisplayScope,
  screen: ScanDisplayScreen,
  action: ScanAction | undefined,
  now: number,
): ScanDisplayScope {
  const selected = action ?? DEFAULT_SCAN_ACTION;
  const inputs = obj(scope.inputs);
  const value = selected.input ? inputs?.[selected.input] : undefined;
  const amount =
    typeof selected.amount === 'number'
      ? selected.amount
      : typeof selected.amount?.default === 'number'
        ? selected.amount.default
        : 1;
  const changes =
    screen === 'ok' &&
    typeof value === 'number' &&
    selected.input &&
    (selected.kind === 'add' || selected.kind === 'take');
  return {
    ...scope,
    scan: {
      outcome: screen,
      reason: screen === 'heads_up' ? 'already_done' : screen === 'refused' ? 'voided' : null,
      at: now,
      method: 'camera',
      direction: 'in',
      action: { id: selected.id, label: selected.label, kind: selected.kind },
      ...(changes
        ? {
            input: selected.input as string,
            amount,
            before: selected.kind === 'add' ? value - amount : value + amount,
            after: value,
          }
        : {}),
    },
    now,
  };
}

export function displayForPreview(doc: DesignDoc, display: ScanDisplayDoc | null): ScanDisplayDoc {
  return display ?? defaultScanDisplay(previewManifest(doc), previewPassFields(doc));
}

export interface PreviewFit {
  units: number;
  header: number;
  headerParts: { label: string; units: number }[];
  capacity: number;
  panels: { id: string; units: number }[];
}

/** The same density table as validation, with the current role applied. */
export function previewFit(
  display: ScanDisplayDoc,
  screen: ScanDisplayScreen,
  flags = 0,
): PreviewFit {
  if (screen === 'refused')
    return { units: 0, header: 0, headerParts: [], capacity: DENSITY.result, panels: [] };
  const header = headerCost(display, screen, flags);
  const headerParts: PreviewFit['headerParts'] = [];
  if (display.notes?.staff) headerParts.push({ label: 'Staff note', units: DENSITY.header.staff });
  if (screen === 'heads_up') headerParts.push({ label: 'Heads-up', units: DENSITY.header.headsUp });
  if (screen === 'ok') {
    const titles = titlesOf(display);
    if (titles.length)
      headerParts.push({
        label: 'Title',
        units:
          DENSITY.header.title + (titles.some(titleTwoLines) ? DENSITY.header.titleSecondLine : 0),
      });
  }
  if (screen !== 'ready' && display.photo)
    headerParts.push({ label: 'Photo', units: DENSITY.header.photo });
  const remaining = header - headerParts.reduce((sum, part) => sum + part.units, 0);
  if (remaining > 0) headerParts.push({ label: 'Chips', units: remaining });
  return {
    units: screenUnits(display, screen, flags),
    header,
    headerParts,
    capacity: DENSITY.result,
    panels: (display.panels ?? []).map((panel) => ({ id: panel.id, units: panelUnits(panel) })),
  };
}

/** Ask the actual renderer whether a missing row would otherwise render, distinguishing cuts from conditions. */
export function cutRows(
  doc: ScanDisplayDoc,
  scope: ScanDisplayScope,
  options: RenderScanDisplayOptions,
  rendered: ScanDisplay,
): Set<string> {
  const shown = new Set(rendered.panels.flatMap((panel) => panel.rows.map((row) => row.id)));
  const cut = new Set<string>();
  if (options.screen === 'refused') return cut;
  for (const panel of doc.panels ?? [])
    for (const row of panel.rows) {
      if (shown.has(row.id)) continue;
      const alone = renderScanDisplay(
        { ...doc, panels: [{ ...panel, rows: [row] }] },
        scope,
        options,
      );
      if (alone.panels.some((item) => item.rows.some((itemRow) => itemRow.id === row.id)))
        cut.add(row.id);
    }
  return cut;
}
