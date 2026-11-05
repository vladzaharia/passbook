/**
 * The pure display functions (C16). Everything under here is pure: no React, no worker imports,
 * no sizes or colours. `/scan` imports only the rendered contract and `icons.ts`, never this file.
 */
export { condPaths, testCond } from './condition.ts';
export { defaultScanDisplay } from './defaults.ts';
export {
  DENSITY,
  density,
  headerCost,
  panelUnits,
  rowUnits,
  screenUnits,
} from './density.ts';
export { EXAMPLES, exampleManifest, type ScanExample } from './examples.ts';
export { SCAN_ICONS, type ScanIconId } from './icons.ts';
export { migrateScanDisplay } from './migrate.ts';
export { compileNeeds, type ScanDisplayNeeds } from './needs.ts';
export { PRESET_ORDER, PRESETS, slotsFound } from './presets.ts';
export { filterDoc, type RenderScanDisplayOptions, renderScanDisplay } from './render.ts';
export { sampleHistory, sampleScope } from './sample.ts';
export {
  actionGoals,
  hiddenFieldKeys,
  scopeCatalog,
  secretInputs,
} from './scope.ts';
export { SCOPE_ROOTS, type ScanDisplayScope } from './text.ts';
export { type ScanDisplayIssueOptions, scanDisplayIssues } from './validate.ts';
export { hasVerdictWord, VERDICT_WORDS } from './validate-rules.ts';
