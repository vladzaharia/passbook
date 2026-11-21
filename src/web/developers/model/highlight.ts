import { escapeHtml } from '../../../shared/html.ts';

/**
 * The portal's one code theme, as HTML at build time (design-portal-visual.md §4): the same token
 * classes in every page, island and .md twin. keys .k, strings .s, literals .l, numbers .n,
 * keywords .kw, calls .fn, comments .c. The JsonViewer's mapping, extended for code.
 */
export type Lang = 'json' | 'curl' | 'cli' | 'ts' | 'py' | 'go';

const KEYWORDS: Record<Lang, string[]> = {
  json: [],
  curl: [],
  cli: [],
  ts: ['const', 'await', 'import', 'from', 'new', 'async', 'function', 'return', 'let'],
  py: ['import', 'from', 'as', 'def', 'return', 'with'],
  go: ['package', 'import', 'func', 'defer', 'if', 'return', 'nil', 'var'],
};
const LITERALS: Record<Lang, string[]> = {
  json: ['true', 'false', 'null'],
  curl: [],
  cli: [],
  ts: ['true', 'false', 'null', 'undefined'],
  py: ['True', 'False', 'None'],
  go: ['true', 'false'],
};
const COMMENT: Record<Lang, string | null> = { json: null, curl: '#', cli: '#', ts: '//', py: '#', go: '//' };

/** A run of text and its token class; no class is plain text. */
export interface Tok {
  cls?: string;
  text: string;
}
const span = (cls: string, text: string): Tok => ({ cls, text });
const plain = (text: string): Tok => ({ text });

/** The caller's own key never renders: samples read it from the environment, shown as a chip. */
export const ENV_CHIP = /(\$?PASSBOOK_(?:KEY|WEBHOOK_SECRET))/g;
const chip = (html: string) => html.replace(ENV_CHIP, '<span class="envchip">$1</span>');
const toHtml = (toks: Tok[]) =>
  toks
    .map((t) =>
      t.cls ? `<span class="${t.cls}">${escapeHtml(t.text)}</span>` : escapeHtml(t.text),
    )
    .join('');

interface State {
  /** The quote of a string still open at the end of the last line (Go raw strings, curl bodies). */
  quote: string | null;
}

function line(text: string, lang: Lang, state: State): Tok[] {
  const comment = COMMENT[lang];
  const out: Tok[] = [];
  let i = 0;
  const kw = new Set(KEYWORDS[lang]);
  const lit = new Set(LITERALS[lang]);
  while (i < text.length) {
    const rest = text.slice(i);
    const ch = text[i] as string;
    if (state.quote) {
      const end = text.indexOf(state.quote, i);
      const stop = end === -1 ? text.length : end + 1;
      out.push(span('s', text.slice(i, stop)));
      i = stop;
      if (end !== -1) state.quote = null;
      continue;
    }
    if (comment && rest.startsWith(comment)) {
      out.push(span('c', rest));
      break;
    }
    if (ch === '`' && lang === 'go') {
      state.quote = '`';
      out.push(span('s', '`'));
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const m = new RegExp(`^${ch}(?:\\\\.|[^${ch}\\\\])*${ch}?`).exec(rest);
      const str = m ? m[0] : ch;
      if ((lang === 'curl' || lang === 'cli') && (str.length < 2 || !str.endsWith(ch))) state.quote = ch;
      const colon = /^\s*:/.test(text.slice(i + str.length));
      out.push(span(lang === 'json' && colon ? 'k' : colon && lang === 'ts' ? 'k' : 's', str));
      i += str.length;
      continue;
    }
    const num = /^-?\d+(?:\.\d+)?/.exec(rest);
    if (num && !/[\w$]/.test(text[i - 1] ?? '')) {
      out.push(span('n', num[0]));
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      const w = word[0];
      const call = text[i + w.length] === '(';
      const key = lang === 'ts' && /^\s*:/.test(text.slice(i + w.length));
      out.push(
        kw.has(w)
          ? span('kw', w)
          : lit.has(w)
            ? span('l', w)
            : key
              ? span('k', w)
              : call
                ? span('fn', w)
                : plain(w),
      );
      i += w.length;
      continue;
    }
    // curl: flags and the verb read as keywords, so a command scans like code.
    out.push(plain(ch));
    i += 1;
  }
  return out;
}

/** Highlighted lines as tokens: what islands draw without touching innerHTML. */
export function highlightTokens(code: string, lang: Lang): Tok[][] {
  const state: State = { quote: null };
  return code
    .split('\n')
    .map((text) => (lang === 'curl' || lang === 'cli' ? curlLine(text, state) : line(text, lang, state)));
}

/** Highlighted lines, each `<span class="ln">`; `mark` lines (1-based) get the highlight bar. */
export function highlight(code: string, lang: Lang, mark: number[] = []): string {
  return highlightTokens(code, lang)
    .map(
      (toks, i) =>
        `<span class="ln${mark.includes(i + 1) ? ' hl' : ''}">${chip(toHtml(toks))}</span>`,
    )
    .join('');
}

function curlLine(text: string, state: State): Tok[] {
  if (state.quote) return line(text, 'curl', state);
  const flag = /^(\s*)(curl|-[A-Za-z]|--[a-z-]+)(\s|$)/.exec(text);
  if (!flag) return line(text, 'curl', state);
  return [
    plain(flag[1] ?? ''),
    span('kw', flag[2] ?? ''),
    plain(flag[3] ?? ''),
    ...line(text.slice(flag[0].length), 'curl', state),
  ];
}
