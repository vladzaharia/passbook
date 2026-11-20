import { escapeHtml } from '../../../shared/html.ts';

/**
 * The portal's one code theme, as HTML at build time (design-portal-visual.md §4): the same token
 * classes in every page, island and .md twin. keys .k, strings .s, literals .l, numbers .n,
 * keywords .kw, calls .fn, comments .c. The JsonViewer's mapping, extended for code.
 */
export type Lang = 'json' | 'curl' | 'ts' | 'py' | 'go';

const KEYWORDS: Record<Lang, string[]> = {
  json: [],
  curl: [],
  ts: ['const', 'await', 'import', 'from', 'new', 'async', 'function', 'return', 'let'],
  py: ['import', 'from', 'as', 'def', 'return', 'with'],
  go: ['package', 'import', 'func', 'defer', 'if', 'return', 'nil', 'var'],
};
const LITERALS: Record<Lang, string[]> = {
  json: ['true', 'false', 'null'],
  curl: [],
  ts: ['true', 'false', 'null', 'undefined'],
  py: ['True', 'False', 'None'],
  go: ['true', 'false'],
};
const COMMENT: Record<Lang, string | null> = { json: null, curl: '#', ts: '//', py: '#', go: '//' };

const span = (cls: string, text: string) => `<span class="${cls}">${escapeHtml(text)}</span>`;

/** The caller's own key never renders: samples read it from the environment, shown as a chip. */
const ENV_CHIP = /(\$?PASSBOOK_KEY)/g;
const chip = (html: string) => html.replace(ENV_CHIP, '<span class="envchip">$1</span>');

interface State {
  /** The quote of a string still open at the end of the last line (Go raw strings, curl bodies). */
  quote: string | null;
}

function line(text: string, lang: Lang, state: State): string {
  const comment = COMMENT[lang];
  let out = '';
  let i = 0;
  const kw = new Set(KEYWORDS[lang]);
  const lit = new Set(LITERALS[lang]);
  while (i < text.length) {
    const rest = text.slice(i);
    const ch = text[i] as string;
    if (state.quote) {
      const end = text.indexOf(state.quote, i);
      const stop = end === -1 ? text.length : end + 1;
      out += span('s', text.slice(i, stop));
      i = stop;
      if (end !== -1) state.quote = null;
      continue;
    }
    if (comment && rest.startsWith(comment)) {
      out += span('c', rest);
      break;
    }
    if (ch === '`' && lang === 'go') {
      state.quote = '`';
      out += span('s', '`');
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const m = new RegExp(`^${ch}(?:\\\\.|[^${ch}\\\\])*${ch}?`).exec(rest);
      const str = m ? m[0] : ch;
      if (lang === 'curl' && (str.length < 2 || !str.endsWith(ch))) state.quote = ch;
      const colon = /^\s*:/.test(text.slice(i + str.length));
      out += span(lang === 'json' && colon ? 'k' : colon && lang === 'ts' ? 'k' : 's', str);
      i += str.length;
      continue;
    }
    const num = /^-?\d+(?:\.\d+)?/.exec(rest);
    if (num && !/[\w$]/.test(text[i - 1] ?? '')) {
      out += span('n', num[0]);
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      const w = word[0];
      const call = text[i + w.length] === '(';
      const key = lang === 'ts' && /^\s*:/.test(text.slice(i + w.length));
      out += kw.has(w)
        ? span('kw', w)
        : lit.has(w)
          ? span('l', w)
          : key
            ? span('k', w)
            : call
              ? span('fn', w)
              : escapeHtml(w);
      i += w.length;
      continue;
    }
    // curl: flags and the verb read as keywords, so a command scans like code.
    out += escapeHtml(ch);
    i += 1;
  }
  return out;
}

/** Highlighted lines, each `<span class="ln">`; `mark` lines (1-based) get the highlight bar. */
export function highlight(code: string, lang: Lang, mark: number[] = []): string {
  const state: State = { quote: null };
  return code
    .split('\n')
    .map((text, i) => {
      const body = lang === 'curl' ? curlLine(text, state) : line(text, lang, state);
      return `<span class="ln${mark.includes(i + 1) ? ' hl' : ''}">${chip(body)}</span>`;
    })
    .join('');
}

function curlLine(text: string, state: State): string {
  if (state.quote) return line(text, 'curl', state);
  const flag = /^(\s*)(curl|-[A-Za-z]|--[a-z-]+)(\s|$)/.exec(text);
  if (!flag) return line(text, 'curl', state);
  const head = `${flag[1] ?? ''}${span('kw', flag[2] ?? '')}${flag[3] ?? ''}`;
  return head + line(text.slice(flag[0].length), 'curl', state);
}
