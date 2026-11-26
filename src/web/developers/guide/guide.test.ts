import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseHash } from '../../workbench/console/prefill.ts';
import { EDGES, lifecycleMermaid, lifecycleSvg } from './lifecycle.ts';
import { consoleHref, prefillFromCurl } from './model.ts';
import { GuideError, linksIn, parseGuide } from './parse.ts';

const HEAD = '---\nid: a\ntitle: A\nline: A line\nstatus: ready\nops: x.y, z.w\n---\n';

describe('parseGuide', () => {
  it('reads the header, headings, lists, tables, fences and directives', () => {
    const doc = parseGuide(
      `${HEAD}Intro text with \`code\`.\n\n## First step\n\n- one\n- two\n\n1. a\n2. b\n\n| Call | Does |\n| --- | --- |\n| \`void\` | marks it |\n\n\`\`\`json run=passes.postPasses\n{ "a": 1 }\n\`\`\`\n\n{{run create-pass}}\n{{show poll-events}}\n{{diagram lifecycle}}\n\n> A note.\n`,
      'a.md',
    );
    expect(doc.meta).toEqual({
      id: 'a',
      title: 'A',
      line: 'A line',
      status: 'ready',
      ops: ['x.y', 'z.w'],
    });
    expect(doc.blocks.map((b) => b.kind)).toEqual([
      'p',
      'h2',
      'ul',
      'ol',
      'table',
      'code',
      'run',
      'show',
      'diagram',
      'quote',
    ]);
    expect(doc.blocks[1]).toMatchObject({ id: 'first-step' });
    expect(doc.blocks[5]).toMatchObject({
      lang: 'json',
      run: 'passes.postPasses',
      text: '{ "a": 1 }',
    });
  });

  it('refuses a missing header, a bad status, an unclosed fence and a stray heading level', () => {
    expect(() => parseGuide('text', 'a.md')).toThrow(GuideError);
    expect(() => parseGuide(HEAD.replace('ready', 'later'), 'a.md')).toThrow(/status must be/);
    expect(() => parseGuide(`${HEAD}\`\`\`json\n{}`, 'a.md')).toThrow(/unclosed/);
    expect(() => parseGuide(`${HEAD}# Top`, 'a.md')).toThrow(/## and ###/);
  });

  it('lists the links of an inline string', () => {
    expect(linksIn('See [x](/developers/a) and [y](console:passes.getPasses).')).toEqual([
      { text: 'x', target: '/developers/a' },
      { text: 'y', target: 'console:passes.getPasses' },
    ]);
  });
});

describe('console links', () => {
  it('round-trips a body and a query through the console hash, and leaves a bare operation alone', () => {
    const body = { input: { attendee: 'Ada & Co ?' }, notify: true };
    const href = consoleHref('passes.postPasses', { body, query: { externalId: 'a b+c' } });
    const hash = href.slice(href.indexOf('#'));
    expect(parseHash(hash)).toEqual({
      id: 'passes.postPasses',
      prefill: { body, query: { externalId: 'a b+c' } },
    });
    expect(consoleHref('passes.getPasses')).toBe('/developers/console#passes.getPasses');
    expect(parseHash('#passes.getPasses')).toEqual({
      id: 'passes.getPasses',
      prefill: { query: {} },
    });
  });

  it('takes the query and body from a curl snippet and never the path ids', () => {
    const curl = `curl -X PATCH "https://passbook.mobile/api/v1/passes/0193a1b2-7c00-7000-8000-0000000000c1?x=1" \\\n  -H "Authorization: Bearer $PASSBOOK_KEY" \\\n  -d '{\n  "notify": true\n}'`;
    expect(prefillFromCurl(curl, 't')).toEqual({ query: { x: '1' }, body: { notify: true } });
    expect(() => prefillFromCurl('curl -d x', 't')).toThrow(/no URL/);
  });
});

describe('lifecycle', () => {
  it('draws every call as a label and says so for assistive tech', () => {
    const svg = lifecycleSvg();
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-labelledby="lc-title lc-desc"');
    expect(svg).not.toContain('style=');
    for (const call of new Set(EDGES.map((e) => e.call))) expect(svg).toContain(`>${call}`);
    expect(lifecycleMermaid()).toContain('Active --> Voided: void');
  });
});

/** WCAG relative luminance contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (bl ?? 0);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

// Read as files: the web project does not load CSS.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const guideCss = read('../styles/dev-guide.css');
const tokens = read('../../../generated/ssr-tokens.css');

describe('lifecycle text contrast', () => {
  it('draws notes in the muted text colour on the page colour, 4.5:1 or better in both themes', () => {
    expect(guideCss).toMatch(/\.lc-note \{[^}]*fill: var\(--pk-text-muted\)/);
    expect(guideCss).toMatch(/\.lc-box \{[^}]*fill: var\(--pk-surface-page\)/);
    const themes = {
      dark: /:root,\[data-theme="dark"\]\{([^}]*)\}/.exec(tokens)?.[1] ?? '',
      light: /\[data-theme="light"\]\{color-scheme:light;([^}]*)\}/.exec(tokens)?.[1] ?? '',
    };
    for (const [name, block] of Object.entries(themes)) {
      const muted = /--pk-text-muted:(#[0-9a-f]{6})/.exec(block)?.[1];
      const page = /--pk-surface-page:(#[0-9a-f]{6})/.exec(block)?.[1];
      expect(muted && page, name).toBeTruthy();
      expect(contrast(muted ?? '', page ?? ''), name).toBeGreaterThanOrEqual(4.5);
    }
  });
});
