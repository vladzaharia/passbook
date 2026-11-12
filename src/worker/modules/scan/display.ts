import {
  condPaths,
  defaultScanDisplay,
  renderScanDisplay,
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
import type { Json } from '../../../passkit/types.ts';
import {
  SCAN_PRESET_KINDS,
  type ScanDisplay,
  type ScanDisplayScreen,
} from '../../../shared/contracts/scan-display.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { scopeOf } from './card-projection.ts';
import {
  safeTimestamp,
  sourcePolicyProven,
  visibleIdentity,
  visibleSource,
} from './card-semantics.ts';
import { authorizedDocument, safeDefaultSources } from './display-document-policy.ts';
import { isOwnPhotoUrl } from './display-photo-url.ts';
import { type CardPrivacy, cardPrivacy } from './dto-projection.ts';
import type { ScanActor } from './guard.ts';
import type { Found } from './resolve.ts';

export interface BuildDisplayInput {
  actor: ScanActor;
  pass: { id: string; title: string } | null;
  screen: ScanDisplayScreen;
  card?: unknown;
  template?: Found;
  scan?: Json;
  history?: unknown;
  /** A capability URL materialized only after its grant insert was confirmed. */
  photoUrl?: string | null;
}

function identity(input: BuildDisplayInput, privacy?: CardPrivacy): ScanDisplay | null {
  if (!input.pass) return null;
  let title: string | null = null;
  try {
    if (input.template && input.actor.role && privacy)
      title = visibleIdentity(input.template, input.actor, privacy).title;
  } catch {
    // A malformed policy is not a reason to expose the cached title.
  }
  const safe = (value: string) => {
    try {
      return privacy?.safe(value) ?? false;
    } catch {
      return false;
    }
  };
  const generic = privacy ? (['Pass', 'Card', ''].find(safe) ?? '') : 'Pass';
  const candidate = title && safe(title) ? title.slice(0, 40) : '';
  const holder = candidate && safe(candidate) ? candidate : generic;
  const initials = holder
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => Array.from(w)[0])
    .join('')
    .toUpperCase();
  return {
    v: 1,
    screen: input.screen,
    templateVersion: '',
    variant: null,
    identity: {
      holder,
      initials: !privacy || safe(initials) ? initials : '',
      photo: null,
    },
    header: { icon: null, title: null, titleLines: 1, meta: null, chips: [] },
    panels: [],
    notes: { staff: null, refused: null },
  };
}

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

/**
 * Check authored literals before rendering truncates or formats them. Binding paths
 * are not output text: the renderer evaluates them against the projected scope.
 */
function safeDocument(
  value: unknown,
  found: Found,
  actor: ScanActor,
  privacy: CardPrivacy,
  scope: ScanDisplayScope,
  key = '',
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
  if (typeof value === 'number') return key === 'v' || privacy.safe(value);
  if (key === 'when' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const path of condPaths(value as ScanCond)) {
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
  }
  if (Array.isArray(value))
    return value.every((entry) => safeDocument(entry, found, actor, privacy, scope, key));
  if (value && typeof value === 'object')
    return Object.entries(value).every(([name, entry]) =>
      safeDocument(entry, found, actor, privacy, scope, name),
    );
  return true;
}

/** Check every emitted data leaf, including numeric and boolean rendered values. */
function safeRendered(
  input: BuildDisplayInput,
  privacy: CardPrivacy,
  display: ScanDisplay,
): ScanDisplay | null {
  const safe = (value: unknown, key = ''): boolean => {
    if (typeof value === 'string' && FORMAT_VALUES[key]?.includes(value)) return true;
    if (key === 'url' && typeof value === 'string' && value === input.photoUrl)
      return isOwnPhotoUrl(value);
    if (
      (typeof value === 'number' || typeof value === 'boolean') &&
      Object.hasOwn(RENDER_CONTROL_KEYS, key)
    )
      return true;
    if (typeof value === 'number' && key === 'at' && input.template)
      return safeTimestamp(input.template, input.actor, privacy, value);
    if (Array.isArray(value)) return value.every((entry) => safe(entry, key));
    if (value && typeof value === 'object')
      return Object.entries(value).every(([name, entry]) => safe(entry, name));
    return privacy.safe(value);
  };
  return safe(display) ? display : identity(input, privacy);
}

/** A broken display cannot interrupt a door decision. */
export function buildDisplay(ctx: ServiceContext, input: BuildDisplayInput): ScanDisplay | null {
  if (!input.pass) return null;
  const found = input.template;
  if (!found) return identity(input);
  if (!sourcePolicyProven(found, input.actor) || input.pass.id !== found.pass.id)
    return identity(input);
  let privacy: CardPrivacy;
  try {
    privacy = cardPrivacy(found, input.actor);
  } catch {
    return identity(input);
  }
  if (!input.actor.role) return identity(input, privacy);
  const options = {
    screen: input.screen,
    role: input.actor.role,
    terminal: input.actor.terminal,
    locale: 'en',
    timeZone: input.actor.timeZone,
    now: ctx.clock.now(),
  };
  try {
    if (!found.scan.display && !safeDefaultSources(found, privacy)) return identity(input, privacy);
    const configured =
      found.scan.display ?? defaultScanDisplay(found.template.manifest, found.passJson);
    // A scanner that hides photos gets no photo slot: even an empty one names the holder in its alt.
    const { photo: _hiddenPhoto, ...withoutPhoto } = configured;
    const doc =
      input.actor.settings.showPhoto === false
        ? withoutPhoto
        : input.photoUrl && !configured.photo
          ? { ...configured, photo: {} }
          : configured;
    const authorized = authorizedDocument(
      found,
      doc,
      options.role,
      options.terminal,
      options.screen,
    );
    const scope = scopeOf(ctx, input, found);
    if (!safeDocument(authorized, found, input.actor, privacy, scope))
      return identity(input, privacy);
    return safeRendered(input, privacy, renderScanDisplay(authorized, scope, options));
  } catch (error) {
    ctx.log.error('scan.display_failed', {
      code: 'SCAN_DISPLAY_FAILED',
      passId: input.pass.id,
      error,
    });
    try {
      if (!safeDefaultSources(found, privacy)) return identity(input, privacy);
      const doc = defaultScanDisplay(found.template.manifest, found.passJson);
      const authorized = authorizedDocument(
        found,
        doc,
        options.role,
        options.terminal,
        options.screen,
      );
      const scope = scopeOf(ctx, input, found);
      if (!safeDocument(authorized, found, input.actor, privacy, scope))
        return identity(input, privacy);
      return safeRendered(input, privacy, renderScanDisplay(authorized, scope, options));
    } catch (fallbackError) {
      ctx.log.error('scan.display_fallback_failed', {
        code: 'SCAN_DISPLAY_FALLBACK_FAILED',
        passId: input.pass.id,
        error: fallbackError,
      });
      return identity(input, privacy);
    }
  }
}
