/**
 * The pure display functions (C16). P0 freezes the signatures; stream DS replaces the bodies.
 * Never imports from `src/worker` or `src/web`.
 */
import type { ScanDisplay, ScanDisplayScreen } from '../../../shared/contracts/scan-display.ts';
import type {
  Json,
  PassJson,
  ScanDisplayDoc,
  ScanPresetId,
  ScanRole,
  TemplateManifest,
  ValidationIssue,
} from '../../types.ts';

export { SCAN_ICONS, type ScanIconId } from './icons.ts';

/** What the doc's bindings read: roots `holder`, `inputs`, `fields`, `pass`, `scan`, `history`, `event`, `scanner`, `lookups`. */
export type ScanDisplayScope = Record<string, Json | undefined>;

export interface RenderScanDisplayOptions {
  screen: ScanDisplayScreen;
  role: ScanRole;
  /** A till: no panels. */
  terminal?: boolean;
  locale: string;
  timeZone: string;
  now: number;
  actionId?: string;
  /** An amount control is open: one panel only. */
  amountOpen?: boolean;
}

/** What a doc needs beyond the pass: history queries and lookups, so the server runs only those. */
export interface ScanDisplayNeeds {
  history: string[];
  ledger: string[];
}

const initialsOf = (holder: string) =>
  holder
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toUpperCase();

/** P0 stub: the identity row only. */
export function renderScanDisplay(
  _doc: ScanDisplayDoc,
  scope: ScanDisplayScope,
  options: RenderScanDisplayOptions,
): ScanDisplay {
  const holder = typeof scope.holder === 'string' ? scope.holder.slice(0, 40) : '';
  return {
    v: 1,
    screen: options.screen,
    templateVersion: '',
    variant: null,
    identity: { holder, initials: initialsOf(holder).slice(0, 2), photo: null },
    header: { icon: null, title: null, titleLines: 1, meta: null, chips: [] },
    panels: [],
    notes: { staff: null, refused: null },
  };
}

/** P0 stub: no issues. */
export function scanDisplayIssues(
  _manifest: TemplateManifest,
  _options: { passJson?: PassJson; assetNames?: string[] },
): ValidationIssue[] {
  return [];
}

/** P0 stub: the empty doc. */
export function defaultScanDisplay(
  _manifest: TemplateManifest,
  _passJson?: PassJson,
): ScanDisplayDoc {
  return { v: 1, header: {} };
}

/** P0 stub: the presets arrive with DS.2. */
export const PRESETS: Partial<Record<ScanPresetId, unknown>> = {};

/** P0 stub: row units of a doc (DM 1.6). */
export function density(_doc: ScanDisplayDoc): number {
  return 0;
}

/** P0 stub: no needs. */
export function compileNeeds(_doc: ScanDisplayDoc): ScanDisplayNeeds {
  return { history: [], ledger: [] };
}

/** P0 stub: binding paths the role may read. */
export function scopeCatalog(_manifest: TemplateManifest, _role: ScanRole): string[] {
  return [];
}

/** P0 stub: a scope for the designer's preview. */
export function sampleScope(
  _manifest: TemplateManifest,
  overrides: ScanDisplayScope = {},
): ScanDisplayScope {
  return { ...overrides };
}
