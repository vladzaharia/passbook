import {
  defaultScanDisplay,
  type RenderScanDisplayOptions,
  renderScanDisplay,
} from '../../../passkit/template/scan-display/index.ts';
import type { ScanCond, ScanDisplayDoc } from '../../../passkit/template/scan-display/schema.ts';
import type { Json } from '../../../passkit/types.ts';
import type { ScanDisplay, ScanDisplayScreen } from '../../../shared/contracts/scan-display.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { scopeOf } from './card-projection.ts';
import { sourcePolicyProven, visibleIdentity } from './card-semantics.ts';
import { authorizedDocument, safeDefaultSources } from './display-document-policy.ts';
import { conditionVisible, documentLeaf, renderedLeaf } from './display-leaf-policy.ts';
import { DROP, dropUnsafeLeaves, pruneDocument } from './display-leaves.ts';
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

/** Prune, render and scrub one document. Unsafe leaves are dropped; null only if nothing fits. */
function renderDocument(
  ctx: ServiceContext,
  input: BuildDisplayInput,
  found: Found,
  privacy: CardPrivacy,
  doc: ScanDisplayDoc,
  options: RenderScanDisplayOptions,
): ScanDisplay | null {
  const authorized = authorizedDocument(
    found,
    doc,
    options.role,
    input.actor.terminal,
    options.screen,
  );
  const scope = scopeOf(ctx, input, found);
  const pruned = pruneDocument(
    authorized,
    (value, key) => documentLeaf(value, key, found, input.actor, privacy),
    (cond) => conditionVisible(cond as ScanCond, found, input.actor, privacy, scope),
  );
  if (pruned === DROP) return null;
  const rendered = renderScanDisplay(pruned as ScanDisplayDoc, scope, options);
  const generic = ['Pass', 'Card', ''].find((name) => privacy.safe(name)) ?? '';
  return dropUnsafeLeaves(
    rendered,
    renderedLeaf(input.photoUrl, !!input.template, privacy),
    generic,
  );
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
  const show = (configured: ScanDisplayDoc): ScanDisplay | null => {
    // A scanner that hides photos gets no photo slot: even an empty one names the holder in its alt.
    const { photo: _hiddenPhoto, ...withoutPhoto } = configured;
    const doc =
      input.actor.settings.showPhoto === false
        ? withoutPhoto
        : input.photoUrl && !configured.photo
          ? { ...configured, photo: {} }
          : configured;
    return renderDocument(ctx, input, found, privacy, doc, options);
  };
  const fallback = (): ScanDisplay | null => {
    const sources = safeDefaultSources(found, privacy);
    return show(defaultScanDisplay(sources.manifest, sources.passJson));
  };
  try {
    return (found.scan.display ? show(found.scan.display) : fallback()) ?? identity(input, privacy);
  } catch (error) {
    ctx.log.error('scan.display_failed', {
      code: 'SCAN_DISPLAY_FAILED',
      passId: input.pass.id,
      error,
    });
    try {
      return fallback() ?? identity(input, privacy);
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
