import type { PassJson } from '../../passkit/types.ts';
import { resolveColors } from './color.ts';
import { safeLocale } from './format.ts';
import { resolveImages } from './images.ts';
import { buildLayout, chooseStyle } from './layout.ts';
import { localize } from './strings.ts';
import { upcomingEvents } from './upcoming.ts';
import type { LayoutView, PassTarget, PassView } from './types.ts';

export interface NormalizeOptions {
  /** Asset file name (e.g. `logo@2x.png`, `en.lproj/strip.png`) → URL the browser can load. */
  assets: Record<string, string>;
  locale?: string;
  /** Parsed `pass.strings` for the locale; see `parsePassStrings`. */
  strings?: Record<string, string>;
  now?: Date;
  /** Which OS generation `layout` and `style` describe. Both are always in `layouts`. */
  target?: PassTarget;
  /** IANA zone for dates; defaults to the runtime's. */
  timeZone?: string;
}

const text = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

export function normalize(pass: PassJson, options: NormalizeOptions): PassView {
  const now = options.now ?? new Date();
  const { locale, bad } = safeLocale(options.locale);
  const warnings = new Set<string>(bad ? ['locale.invalid'] : []);
  const ctx = {
    locale,
    now,
    warnings,
    ...(options.strings ? { strings: options.strings } : {}),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  };
  const build = (target: PassTarget): LayoutView => {
    const choice = chooseStyle(pass, target) ?? {
      style: 'generic' as const,
      poster: false,
      degraded: false,
      fields: {},
    };
    return buildLayout(pass, target, choice, ctx);
  };
  const layouts = { ios27: build('ios27'), legacy: build('legacy') };
  const target = options.target ?? 'ios27';
  const layout = layouts[target];
  const voided = pass.voided === true;
  const expired =
    typeof pass.expirationDate === 'string' &&
    new Date(pass.expirationDate).getTime() < now.getTime();
  const loc = (k: string) =>
    typeof pass[k] === 'string' ? localize(options.strings, pass[k]) : undefined;
  const logoText = loc('logoText');
  const eventLogoText = loc('eventLogoText');
  return {
    style: layout.style,
    target,
    layout,
    layouts,
    hasAlternate: facesDiffer({ layouts }),
    organizationName: localize(options.strings, text(pass.organizationName)),
    description: localize(options.strings, text(pass.description)),
    ...(logoText ? { logoText } : {}),
    ...(eventLogoText ? { eventLogoText } : {}),
    colors: resolveColors(pass),
    images: resolveImages(options.assets, locale),
    upcoming: upcomingEvents(pass, ctx),
    voided,
    expired,
    invalid: voided ? 'voided' : expired ? 'expired' : null,
    suppressHeaderDarkening: pass.suppressHeaderDarkening === true,
    locations: (Array.isArray(pass.locations) ? pass.locations : []).flatMap((l) =>
      typeof l?.latitude === 'number' && typeof l.longitude === 'number'
        ? [
            {
              latitude: l.latitude,
              longitude: l.longitude,
              ...(l.relevantText ? { relevantText: l.relevantText } : {}),
            },
          ]
        : [],
    ),
    ...(typeof pass.relevantDate === 'string' ? { relevantDate: pass.relevantDate } : {}),
    locale,
    warnings: [...warnings],
  };
}

const shape = (l: LayoutView) =>
  JSON.stringify([
    l.style,
    l.poster,
    l.degraded,
    l.semantic?.kind,
    [l.header, l.primary, l.secondary, l.auxiliary.flat(), l.footer].map((r) =>
      r.map((f) => f.key),
    ),
    l.barcode?.format,
  ]);

/** True when iOS 27 and iOS 26 draw different faces: only then does the target toggle show. */
export function facesDiffer(view: Pick<PassView, 'layouts'>): boolean {
  return shape(view.layouts.ios27) !== shape(view.layouts.legacy);
}
