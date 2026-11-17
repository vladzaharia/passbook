import {
  condPaths,
  SCAN_ICONS,
  type ScanDisplayScope,
} from '../../../passkit/template/scan-display/index.ts';
import type { ScanCond } from '../../../passkit/template/scan-display/schema.ts';
import {
  parseParts,
  pathTokens,
  resolve as resolveDisplayPath,
  splitPath,
} from '../../../passkit/template/scan-display/text.ts';
import { SCAN_PRESET_KINDS } from '../../../shared/contracts/scan-display.ts';
import { safeTimestamp, visibleSource } from './card-semantics.ts';
import { isOwnPhotoUrl } from './display-photo-url.ts';
import type { CardPrivacy } from './dto-projection.ts';
import type { ScanActor } from './guard.ts';
import type { Found } from './resolve.ts';

// These are renderer discriminants, not authored display text. Only documented
// values are exempt; an arbitrary string in one of these slots is still checked.
const FORMAT_VALUES: Record<string, readonly string[]> = {
  type: [
    'heading',
    'field',
    'big',
    'columns',
    'progress',
    'money',
    'history',
    'image',
    'chips',
    'list',
    'note',
    'divider',
  ],
  kind: SCAN_PRESET_KINDS,
  icon: SCAN_ICONS,
  tone: ['neutral', 'teal', 'violet', 'gold', 'info', 'attention'],
  source: ['value', 'visits', 'scans', 'thumbnail', 'strip'],
  style: ['auto', 'stamps', 'bar'],
  size: ['big', 'normal'],
  screen: ['ready', 'ok', 'heads_up', 'refused'],
  minRole: ['door', 'desk', 'manager'],
};
const RENDER_CONTROL_KEYS: Record<string, true> = {
  v: true,
  titleLines: true,
  strong: true,
  oneLine: true,
  pair: true,
  low: true,
  elsewhere: true,
};
const EXPRESSION_KEYS: Record<string, true> = {
  holder: true,
  currency: true,
  title: true,
  subtitle: true,
  text: true,
  label: true,
  value: true,
  detail: true,
  unit: true,
  reward: true,
  rewards: true,
  amount: true,
  goal: true,
  count: true,
  zero: true,
  one: true,
  other: true,
};

/** A missing restricted selector must not become the renderer's literal-key fallback. */
function visibleSelectors(
  tokens: string[],
  found: Found,
  actor: ScanActor,
  privacy: CardPrivacy,
): boolean {
  const active = found.activePolicy ?? found.activeTemplate ?? found.template;
  for (const token of tokens) {
    if (!token.startsWith('[')) continue;
    const selector = token.slice(1, -1).trim();
    const declared =
      Object.hasOwn(found.pass.personalization, selector) ||
      Object.hasOwn(found.template.manifest.inputs.properties ?? {}, selector) ||
      Object.hasOwn(active.manifest.inputs.properties ?? {}, selector);
    if (declared && !visibleSource(found, actor, selector, privacy)) return false;
  }
  return true;
}

/** The paths in `when` must come from sources this actor may read, and its literals must be safe. */
export function conditionVisible(
  cond: ScanCond,
  found: Found,
  actor: ScanActor,
  privacy: CardPrivacy,
  scope: ScanDisplayScope,
): boolean {
  const literals = (value: unknown, key = ''): boolean => {
    if (key === 'path' || key === 'input') return true;
    if (typeof value === 'string' || typeof value === 'number') return privacy.safe(value);
    if (Array.isArray(value)) return value.every((entry) => literals(entry, key));
    if (value && typeof value === 'object')
      return Object.entries(value).every(([name, entry]) => literals(entry, name));
    return true;
  };
  if (!literals(cond)) return false;
  for (const path of condPaths(cond)) {
    const tokens = pathTokens(path);
    const source = splitPath(path);
    if (!tokens || !source || !visibleSelectors(tokens, found, actor, privacy)) return false;
    if (source.root === 'inputs') {
      const input = source.rest.filter((token) => !token.startsWith('[')).join('.');
      if (!input || !visibleSource(found, actor, input, privacy)) return false;
    } else if (source.root !== 'holder' && resolveDisplayPath(scope, path) === undefined) {
      return false;
    }
  }
  return true;
}

/**
 * Whether an authored leaf may be rendered. Binding paths are not output text: the renderer
 * evaluates them against the projected scope, so only literals and selectors are judged here.
 */
export function documentLeaf(
  value: unknown,
  key: string,
  found: Found,
  actor: ScanActor,
  privacy: CardPrivacy,
): boolean {
  if (typeof value === 'string') {
    if (FORMAT_VALUES[key]?.includes(value)) return true;
    if (Object.hasOwn(EXPRESSION_KEYS, key) && value.includes('{{')) {
      const parts = parseParts(value).parts;
      if (!parts) return false;
      for (const part of parts) {
        if (part.literal !== undefined && !privacy.safe(part.literal)) return false;
        if (!part.path) continue;
        const tokens = pathTokens(part.path);
        if (!tokens || !visibleSelectors(tokens, found, actor, privacy)) return false;
      }
      return true;
    }
    return privacy.safe(value);
  }
  // Numeric authoring literals can affect a displayed decision (for example a
  // low-balance threshold) even when the number itself is not rendered.
  return key === 'v' || privacy.safe(value);
}

/** Whether a rendered leaf may leave the server: a secret or a contact in any slot is not shown. */
export function renderedLeaf(
  photoUrl: string | null | undefined,
  hasTemplate: boolean,
  privacy: CardPrivacy,
) {
  return (value: unknown, key: string): boolean => {
    if (typeof value === 'string' && FORMAT_VALUES[key]?.includes(value)) return true;
    if (key === 'url' && typeof value === 'string' && value === photoUrl)
      return isOwnPhotoUrl(value);
    if (typeof value === 'number' && Object.hasOwn(RENDER_CONTROL_KEYS, key)) return true;
    if (typeof value === 'number' && key === 'at' && hasTemplate)
      return safeTimestamp(privacy, value);
    return privacy.safe(value);
  };
}
