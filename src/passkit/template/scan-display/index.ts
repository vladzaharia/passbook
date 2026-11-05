/**
 * The pure display functions (C16). Everything under here is pure: no React, no worker imports,
 * no sizes or colours. `/scan` imports only the rendered contract and `icons.ts`, never this file.
 */
import type {
  Json,
  PassJson,
  ScanDisplayDoc,
  ScanPresetId,
  TemplateManifest,
} from '../../types.ts';

export { condPaths, testCond } from './condition.ts';
export {
  DENSITY,
  density,
  headerCost,
  panelUnits,
  rowUnits,
  screenUnits,
} from './density.ts';
export { SCAN_ICONS, type ScanIconId } from './icons.ts';
export { migrateScanDisplay } from './migrate.ts';
export { compileNeeds, type ScanDisplayNeeds } from './needs.ts';
export { filterDoc, type RenderScanDisplayOptions, renderScanDisplay } from './render.ts';
export {
  actionGoals,
  hiddenFieldKeys,
  scopeCatalog,
  secretInputs,
} from './scope.ts';
export { SCOPE_ROOTS, type ScanDisplayScope } from './text.ts';
export { type ScanDisplayIssueOptions, scanDisplayIssues } from './validate.ts';
export { hasVerdictWord, VERDICT_WORDS } from './validate-rules.ts';

/** DS.1 stubs, replaced by DS.2: the empty doc, no presets, the manifest's sample. */
export function defaultScanDisplay(
  _manifest: TemplateManifest,
  _passJson?: PassJson,
): ScanDisplayDoc {
  return { v: 1, header: {} };
}
export const PRESETS: Partial<Record<ScanPresetId, unknown>> = {};
export function sampleScope(
  _manifest: TemplateManifest,
  overrides: Record<string, Json | undefined> = {},
): Record<string, Json | undefined> {
  return { ...overrides };
}
