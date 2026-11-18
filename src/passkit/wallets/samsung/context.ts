/** The state one compile run carries: attributes so far, fidelity items and the first block. */
import { fitText, lengthItem } from '../text.ts';
import type {
  BlockCode,
  CapabilityId,
  CompileOptions,
  FidelityItem,
  PassBlock,
  Support,
  WalletPassView,
} from '../types.ts';
import { type LimitedAttribute, SAMSUNG_LIMITS } from './limits.ts';

/** The card types this compiler writes. `generic` and `giftcard` compile as `loyalty` (Q14). */
export type SamsungType = 'loyalty' | 'ticket' | 'coupon';
export type Attributes = Record<string, string>;

export interface SamsungCompileOptions extends CompileOptions {
  /** The holder portal URL: the app link when the organization has no website (Q22). */
  portalUrl?: string;
  /** When the pass was issued: ticket and coupon `issueDate`. Falls back to `now`. */
  issuedAt?: Date;
  /** The card's `language`. Default `en`. */
  language?: string;
}

export interface Run {
  view: WalletPassView;
  opts: SamsungCompileOptions;
  type: SamsungType;
  /** Translates a source string into the locale this run writes. */
  tr: (value: string) => string;
  attrs: Attributes;
  items: FidelityItem[];
  blocked?: PassBlock;
}

export function newRun(
  view: WalletPassView,
  opts: SamsungCompileOptions,
  type: SamsungType,
  tr: (value: string) => string = (v) => v,
): Run {
  return { view, opts, type, tr, attrs: {}, items: [] };
}

export function note(
  run: Run,
  capability: CapabilityId,
  path: string,
  support: Support,
  message: string,
): void {
  run.items.push({ capability, path, support, message });
}

/** The author listed this capability or field in `samsung.omit`. */
export function isChosen(run: Run, capability: CapabilityId, path = ''): boolean {
  return run.opts.omit.some(
    (entry) =>
      entry === capability || (path !== '' && (entry === path || path.endsWith(`.${entry}`))),
  );
}

/** Records the first pass-level block; later ones add nothing. */
export function block(run: Run, code: BlockCode, message: string): void {
  run.blocked ??= { code, message };
}

/** Display text for a limited attribute: shortened with an ellipsis and reported once (Q20). */
export function setDisplay(run: Run, key: LimitedAttribute, value: string, path = key): void {
  const limit = SAMSUNG_LIMITS[key];
  const fit = fitText(value, limit, 'display');
  if (fit.status === 'shortened') {
    const item = lengthItem({ path, limit, value });
    if (item) run.items.push(item);
  }
  run.attrs[key] = fit.text;
}

/** A value that must arrive whole (a link, an identity). Over the limit it blocks the pass. */
export function setWhole(
  run: Run,
  key: LimitedAttribute,
  value: string,
  code: BlockCode,
  what: string,
): boolean {
  const limit = SAMSUNG_LIMITS[key];
  if (fitText(value, limit, 'identity').status === 'too-long') {
    block(run, code, `${what} is longer than Samsung allows (${limit.max} bytes).`);
    return false;
  }
  run.attrs[key] = value;
  return true;
}
