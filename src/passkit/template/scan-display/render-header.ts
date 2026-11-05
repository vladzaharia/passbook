/** The identity and header slots (DM 1.3): the holder line, the band title and its name check. */
import { DENSITY } from './density.ts';
import { graphemeLength, HAS_HIDDEN, plain, sanitized, truncate } from './format.ts';
import type { ScanText } from './schema.ts';
import { type EvalCtx, evalString, evalText } from './text.ts';
import { hasVerdictWord } from './validate-rules.ts';

const NAME = /^[\p{L}\p{M}]+([ '’.-][\p{L}\p{M}]+)*\.?$/u;
const FALLBACK_HOLDER = 'Pass';

/** 1-3 words of letters, no verdict word, nothing hidden: a name, not a message. */
export function plausibleName(value: string, maxWords: number): boolean {
  if (value === '' || HAS_HIDDEN.test(value)) return false;
  if (value.split(' ').length > maxWords || !NAME.test(value)) return false;
  return !hasVerdictWord(value);
}

export interface Names {
  name: string;
  firstName: string;
  initials: string;
  /** The source value held no control or bidi characters. */
  clean: boolean;
}

export function holderNames(raw: string, ctx: EvalCtx): Names {
  const pass = ctx.scope.pass as Record<string, unknown> | undefined;
  const name =
    sanitized(raw, 40) ||
    sanitized(plain(pass?.title as string), 40) ||
    sanitized(plain(pass?.templateName as string), 40) ||
    FALLBACK_HOLDER;
  const words = name.split(' ');
  const initials = words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toLocaleUpperCase()
    .slice(0, 2);
  return { name, firstName: words[0] ?? name, initials, clean: !HAS_HIDDEN.test(raw) };
}

const MARK = '\u0001';

/** The band title: literal text plus the holder's name when it reads as one. Null: the system headline. */
export function bandTitle(
  title: ScanText | null | undefined,
  ctx: EvalCtx,
  names: Names,
): { text: string | null; lines: 1 | 2 } {
  if (title === null || title === undefined) return { text: null, lines: 1 };
  const withHolder = (holder: Record<string, string>): EvalCtx => ({
    ...ctx,
    scope: { ...ctx.scope, holder },
  });
  const marked = evalText(title, withHolder({ name: MARK, firstName: MARK, initials: '' }));
  const tokens = marked.split(MARK).length - 1;
  const room = DENSITY.titleCap - (graphemeLength(marked) - tokens);
  if (marked === '' || (tokens > 0 && room < 1)) return { text: null, lines: 1 };
  const checked = {
    name: names.clean && plausibleName(names.name, 3) ? truncate(names.name, room) : '',
    firstName:
      names.clean && plausibleName(names.firstName, 1) ? truncate(names.firstName, room) : '',
    initials: names.initials,
  };
  const out = sanitized(evalText(title, withHolder(checked)), DENSITY.titleCap);
  if (out === '') return { text: null, lines: 1 };
  return { text: out, lines: graphemeLength(out) <= DENSITY.titleOneLine ? 1 : 2 };
}

/** An ISO 4217-shaped code from the doc's `currency`, or null. */
export function docCurrency(source: string | undefined, ctx: EvalCtx): string | null {
  if (!source) return null;
  const code = evalString(source, ctx).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}
