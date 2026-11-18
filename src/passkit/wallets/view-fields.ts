/** The field part of the view: front-to-back order, display text and links. */
import { BINDING_STYLE_GROUPS } from '../template/pointer.ts';
import type { Json, PassField, PassJson, PassStyle } from '../types.ts';
import type { ViewLinkKind } from './types.ts';
import { VIEW_GROUPS, type ViewField, type ViewGroup, type ViewLink } from './types.ts';

/** The style a pass is read as: a legacy style wins over `posterGeneric`, which pairs with it. */
const STYLE_PRIORITY: readonly PassStyle[] = [
  'eventTicket',
  'boardingPass',
  'storeCard',
  'coupon',
  'generic',
  'posterGeneric',
];

export function styleOf(pass: PassJson): PassStyle {
  return STYLE_PRIORITY.find((s) => typeof pass[s] === 'object' && pass[s] !== null) ?? 'generic';
}

export const fieldPath = (group: ViewGroup, key: string): string => `${group}Fields.${key}`;

export function linkKind(url: string): ViewLinkKind {
  if (/^tel:/iu.test(url)) return 'tel';
  if (/^mailto:/iu.test(url)) return 'mailto';
  if (/^https:\/\//iu.test(url)) return 'web';
  return 'other';
}

const ANCHOR = /<a\s[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>(.*?)<\/a>/giu;

/** `<a href>` links of an attributed value, then the plain value when it is itself a link. */
export function parseLinks(attributed: Json | undefined, text: string): ViewLink[] {
  const out: ViewLink[] = [];
  if (typeof attributed === 'string')
    for (const m of attributed.matchAll(ANCHOR)) {
      const url = (m[2] ?? '').trim();
      if (url) out.push({ kind: linkKind(url), url, ...(m[3] ? { text: m[3].trim() } : {}) });
    }
  const bare = text.trim();
  if (out.length === 0 && /^(?:tel:|mailto:|https:\/\/)\S+$/iu.test(bare))
    out.push({ kind: linkKind(bare), url: bare });
  return out;
}

export function displayText(value: Json | undefined): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Every field in front-to-back order (header, primary, secondary, auxiliary, additionalInfo, footer, back). */
export function buildFields(pass: PassJson, style: PassStyle): ViewField[] {
  const dicts = [style, ...BINDING_STYLE_GROUPS.styles.filter((s) => s !== style)]
    .map((s) => pass[s] as Record<string, unknown> | undefined)
    .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null);
  const seen = new Set<string>();
  const out: ViewField[] = [];
  for (const group of VIEW_GROUPS)
    for (const dict of dicts) {
      const list = dict[`${group}Fields`];
      if (!Array.isArray(list)) continue;
      for (const raw of list as PassField[]) {
        const path = fieldPath(group, raw.key);
        if (seen.has(path)) continue;
        seen.add(path);
        const text = displayText(raw.value);
        out.push({
          group,
          key: raw.key,
          path,
          order: out.length,
          ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
          value: raw.value,
          text,
          links: parseLinks(raw.attributedValue, text),
          ...(typeof raw.dateStyle === 'string' ? { dateStyle: raw.dateStyle } : {}),
          ...(typeof raw.timeStyle === 'string' ? { timeStyle: raw.timeStyle } : {}),
          ...(typeof raw.numberStyle === 'string' ? { numberStyle: raw.numberStyle } : {}),
          ...(typeof raw.currencyCode === 'string' ? { currencyCode: raw.currencyCode } : {}),
          ...(typeof raw.changeMessage === 'string' ? { changeMessage: raw.changeMessage } : {}),
          ...(raw.semantics ? { semantics: raw.semantics } : {}),
        });
      }
    }
  return out;
}
