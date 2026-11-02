import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = join(process.cwd(), 'src/web');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return name.endsWith('.css') ? [path] : [];
  });
const css = walk(WEB)
  .map((path) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
  .join('\n');

interface Rule {
  selectors: string[];
  body: string;
  media: string;
}

/** Flat rules with the innermost enclosing @media condition. */
function rules(text: string): Rule[] {
  const out: Rule[] = [];
  const walkBlock = (src: string, media: string) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      const body = src.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walkBlock(body, head);
      else if (!head.startsWith('@')) {
        const selectors = head.split(/,(?![^(]*\))/).map((s) => s.trim());
        out.push({ selectors, body, media });
      }
      i = j;
    }
  };
  walkBlock(text, '');
  return out;
}

/** [ids, classes + attributes + pseudo-classes, elements]; :is() and :where() handled. */
function specificity(selector: string): number {
  let s = selector.replace(/:where\([^)]*\)/g, '');
  let extra = 0;
  s = s.replace(/:(?:is|not|has)\(([^)]*)\)/g, (_m, inner: string) => {
    extra += Math.max(...inner.split(',').map((x) => specificity(x.trim())));
    return '';
  });
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const elements = (s.replace(/\[[^\]]+\]/g, '').match(/(?:^|[\s>+~])[a-z][\w-]*|::[\w-]+/g) ?? [])
    .length;
  return ids * 10_000 + classes * 100 + elements + extra;
}

const all = rules(css);
const moving = new Set(
  [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?\}\s*)\}/g)]
    .filter(([, , body]) => /transform|translate|rotate|scale/.test(body ?? ''))
    .map(([, name]) => name),
);
const reduce = all.filter((r) => r.media.includes('prefers-reduced-motion: reduce'));
const leadClass = (selector: string) => /\.[\w-]+/.exec(selector)?.[0];

describe('reduced motion', () => {
  it('overrides every literal-duration transform animation with equal or higher specificity', () => {
    const leaks: string[] = [];
    for (const rule of all) {
      if (rule.media.includes('prefers-reduced-motion')) continue;
      const anim = /(?:^|;)\s*animation:\s*([^;]+)/.exec(rule.body)?.[1] ?? '';
      const name = anim.trim().split(/\s+/)[0] ?? '';
      if (!moving.has(name) || !/\d+ms/.test(anim) || /infinite/.test(anim)) continue;
      for (const selector of rule.selectors) {
        // View-transition pseudos stop under one !important rule in motion.css.
        const lead = selector.startsWith('::view-transition') ? undefined : leadClass(selector);
        if (!lead) continue;
        const covered = reduce.some((r) =>
          r.selectors.some(
            (s) =>
              s.includes(lead) &&
              specificity(s) >= specificity(selector) &&
              /animation/.test(r.body),
          ),
        );
        if (!covered) leaks.push(`${selector} (${name})`);
      }
    }
    expect(leaks).toEqual([]);
  });
});
