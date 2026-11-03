/**
 * A small CSS reader for the token sheets (brand tokens.css, wallet.css, motion.css, fonts.css):
 * rules with their at-rule wrappers, the custom-property blocks as minified CSS, and the cascade
 * resolved for one theme. Enough CSS for those files, not a general parser.
 */

export interface Rule {
  /** Enclosing at-rule preludes, outermost first, e.g. `@media (prefers-color-scheme: light)`. */
  at: string[];
  /** `@font-face` for a font face; else the selector list. */
  selector: string;
  decls: [string, string][];
}

const squash = (s: string) =>
  s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

/** Index of the brace closing the block that opens at `open`. */
function closing(css: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  throw new Error(`Unbalanced block at ${open}`);
}

function declarations(body: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let start = 0;
  const push = (end: number) => {
    const part = body.slice(start, end);
    const colon = part.indexOf(':');
    if (colon > 0) out.push([part.slice(0, colon).trim(), squash(part.slice(colon + 1))]);
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ';' && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(body.length);
  return out;
}

/** Every style rule and font face, in source order. Keyframes and statements are skipped. */
export function parseCss(source: string, at: string[] = []): Rule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    const semi = css.indexOf(';', i);
    if (open < 0) break;
    if (semi >= 0 && semi < open && css.slice(i, semi).trim().startsWith('@')) {
      i = semi + 1;
      continue;
    }
    const prelude = squash(css.slice(i, open));
    const end = closing(css, open);
    const body = css.slice(open + 1, end);
    if (/^@(media|supports)\b/.test(prelude)) rules.push(...parseCss(body, [...at, prelude]));
    else if (/^@layer\b/.test(prelude)) rules.push(...parseCss(body, at));
    else if (!prelude.startsWith('@') || prelude === '@font-face') {
      const selector = prelude === '@font-face' ? prelude : prelude.replace(/\s*,\s*/g, ',');
      rules.push({ at, selector, decls: declarations(body) });
    }
    i = end + 1;
  }
  return rules;
}

/** Rules back to minified CSS, one line per rule; adjacent rules under one at-rule share it. */
export function printCss(rules: Rule[]): string {
  const lines: string[] = [];
  let open: string[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (!buffer.length) return;
    const body = buffer.join('');
    lines.push(open.reduceRight((inner, prelude) => `${prelude}{${inner}}`, body));
    buffer = [];
  };
  for (const rule of rules) {
    if (rule.at.join('\n') !== open.join('\n')) {
      flush();
      open = rule.at;
    }
    const decls = rule.decls.map(([k, v]) => `${k}:${v}`).join(';');
    buffer.push(`${rule.selector}{${decls}}`);
    if (!open.length) flush();
  }
  flush();
  return `${lines.join('\n')}\n`;
}

/** The token part of a sheet: custom properties (plus color-scheme), same selectors. */
export function tokenRules(rules: Rule[], keep: (name: string) => boolean): Rule[] {
  return rules
    .filter((r) => r.selector !== '@font-face')
    .map((r) => ({
      ...r,
      decls: r.decls.filter(
        ([k]) => (k.startsWith('--') && keep(k)) || k === 'color-scheme' || k === 'font-synthesis',
      ),
    }))
    .filter((r) => r.decls.length > 0);
}

export interface Env {
  /** The OS appearance. */
  system: 'light' | 'dark';
  /** `data-theme` on the root element, if any. */
  attr?: 'light' | 'dark';
}

function mediaMatches(prelude: string, env: Env): boolean {
  const scheme = /prefers-color-scheme:\s*(light|dark)/.exec(prelude)?.[1];
  if (scheme && scheme !== env.system) return false;
  // Increase Contrast, reduced motion and missing features are off in the resolved theme.
  if (/prefers-contrast|prefers-reduced-motion|@supports not/.test(prelude)) return false;
  return true;
}

/** Specificity of a selector that matches the root, as attributes plus pseudo-classes; else -1. */
function rootSpecificity(selector: string, env: Env): number {
  const bare = selector.replace(/:not\(([^)]*)\)/g, (_, inner: string) => `!${inner}`);
  for (const m of bare.matchAll(/(!?)\[([a-z-]+)(?:="([a-z]+)")?\]/g)) {
    const [, negated, name, value] = m;
    const has =
      name === 'data-theme' ? env.attr !== undefined && (!value || value === env.attr) : false;
    if (negated ? has : !has) return -1;
  }
  if (!/^(:root)?(\[|:not|$)/.test(selector) || /\s/.test(selector)) return -1;
  return (selector.match(/\[/g)?.length ?? 0) + (selector.match(/:root/g)?.length ?? 0);
}

/** The custom properties on the root element for `env`, every var() resolved. */
export function resolveTheme(rules: Rule[], env: Env): Map<string, string> {
  const winners = new Map<string, { value: string; spec: number }>();
  for (const rule of rules) {
    if (rule.selector === '@font-face' || !rule.at.every((p) => mediaMatches(p, env))) continue;
    const spec = Math.max(...rule.selector.split(',').map((s) => rootSpecificity(s, env)));
    if (spec < 0) continue;
    for (const [name, value] of rule.decls) {
      if (!name.startsWith('--')) continue;
      const prev = winners.get(name);
      // Source order breaks ties, so a later rule of equal specificity wins.
      if (!prev || spec >= prev.spec) winners.set(name, { value, spec });
    }
  }
  const raw = new Map([...winners].map(([k, v]) => [k, v.value]));
  const resolve = (value: string, depth = 0): string =>
    depth > 20
      ? value
      : value.replace(/var\((--[a-z0-9-]+)(?:,\s*([^()]*))?\)/g, (_, name: string, fallback) => {
          const v = raw.get(name);
          return v === undefined ? (fallback ?? '') : resolve(v, depth + 1);
        });
  return new Map([...raw].map(([k, v]) => [k, resolve(v)]));
}
