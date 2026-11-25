import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EDGES, LIFECYCLE_DESC, lifecycleMermaid } from '../lifecycle.ts';
import { DiagramError, diagramMermaid, diagramSvg, parseDiagram, renderDiagram } from './index.ts';
import { diagramSpec, TONES } from './spec.ts';
import { TIERS } from './svg.ts';

const here = (rel: string) => new URL(rel, import.meta.url);
const dir = here('../../../../../docs/developers/diagrams/');
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'schema.json');
const load = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8'));
const names = files.map((f) => f.replace(/\.json$/, ''));
const css = ['dev-diagram', 'dev-diagram-list']
  .map((f) => readFileSync(here(`../../styles/${f}.css`), 'utf8'))
  .join('\n');
const tokens = readFileSync(here('../../../../generated/ssr-tokens.css'), 'utf8');

describe('diagram files', () => {
  it('has at least the lifecycle and the checkout-to-pass example', () => {
    expect(names).toContain('pass-lifecycle');
    expect(names).toContain('checkout-to-pass');
  });

  it.each(names)('%s parses, and title and desc are present', (name) => {
    const spec = parseDiagram(load(name), name);
    expect(spec.title.length).toBeGreaterThan(0);
    expect(spec.desc.length).toBeLessThanOrEqual(300);
  });

  it('schema.json matches the zod schema', () => {
    const fresh = `${JSON.stringify(z.toJSONSchema(diagramSpec), null, 2)}\n`;
    const path = new URL('schema.json', dir);
    // Run biome format on schema.json after rewriting it.
    if (process.env.UPDATE_DIAGRAM_SCHEMA) writeFileSync(path, fresh);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(fresh));
  });
});

describe('spec checks', () => {
  const seq = () => structuredClone(load('checkout-to-pass'));
  const flow = () => structuredClone(load('pass-lifecycle'));

  it('rejects a missing desc, an over-long desc and unknown keys', () => {
    const a = seq();
    a.desc = undefined;
    expect(() => parseDiagram(a)).toThrow(DiagramError);
    expect(() => parseDiagram({ ...seq(), desc: 'x'.repeat(301) })).toThrow(DiagramError);
    expect(() => parseDiagram({ ...seq(), colour: 'red' })).toThrow(DiagramError);
  });

  it('rejects duplicate ids and dangling references', () => {
    const a = seq();
    a.actors[1].id = 'shop';
    expect(() => parseDiagram(a)).toThrow(/duplicate actor/);
    const b = seq();
    b.steps[0].to = 'nobody';
    expect(() => parseDiagram(b)).toThrow(/unknown actor/);
    const c = flow();
    c.edges[0].to = 'nowhere';
    expect(() => parseDiagram(c)).toThrow(/unknown node/);
    const d = flow();
    d.nodes[1].col = 0;
    expect(() => parseDiagram(d)).toThrow(/overlaps/);
  });
});

describe('label fit', () => {
  it('fails the build when a node label cannot fit its box', () => {
    const spec = parseDiagram({
      title: 'T',
      desc: 'D',
      kind: 'flow',
      nodes: [
        { id: 'a', label: 'W'.repeat(32), col: 0, row: 0 },
        { id: 'b', label: 'B', col: 1, row: 0 },
      ],
      edges: [{ from: 'a', to: 'b', label: 'go' }],
    });
    expect(() => diagramSvg('x', spec)).toThrow(/box holds/);
  });

  it('fails when a spanned node needs more than its columns give', () => {
    const f = load('pass-lifecycle');
    f.nodes[3].note = 'n'.repeat(80);
    f.nodes[3].span = 1;
    f.nodes[3].col = 0;
    f.nodes[3].row = 1;
    expect(() => diagramSvg('x', parseDiagram(f))).toThrow(DiagramError);
  });

  it('fails when a step label is wider than any lane could hold', () => {
    const s = load('checkout-to-pass');
    s.steps[0].label = 'M'.repeat(60);
    expect(() => diagramSvg('x', parseDiagram(s))).toThrow(/box holds/);
  });

  it('widens lanes so every shipped label fits, and keeps notes clear of the step numbers', () => {
    for (const name of names)
      expect(() => diagramSvg(name, parseDiagram(load(name)))).not.toThrow();
  });
});

describe('determinism', () => {
  it.each(names)('%s renders the same bytes twice, whatever the key order', (name) => {
    const raw = load(name);
    const reordered = Object.fromEntries(Object.entries(raw).reverse());
    const a = renderDiagram(name, parseDiagram(raw));
    expect(renderDiagram(name, parseDiagram(raw))).toBe(a);
    expect(renderDiagram(name, parseDiagram(reordered))).toBe(a);
    expect(diagramMermaid(parseDiagram(raw))).toBe(diagramMermaid(parseDiagram(reordered)));
  });
});

describe('themed with kit tokens only', () => {
  it.each(names)('%s has no colour, style attribute or script in its output', (name) => {
    const html = renderDiagram(name, parseDiagram(load(name)));
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/\b(?:rgb|hsl|oklch|oklab)a?\(/);
    expect(html).not.toMatch(/\sstyle=|\sfill=|\sstroke=|<style|<script|<foreignObject/i);
  });

  it('dev-diagram.css writes no colour and only uses tokens that exist', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(?:rgb|hsl)a?\(/);
    const used = new Set(css.match(/--pk-[a-z0-9-]+/g));
    expect(used.size).toBeGreaterThan(20);
    for (const t of used) expect(tokens, t).toContain(`${t}:`);
  });
});

/** WCAG contrast of two #rrggbb colours. */
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

/** The value of `prop` as a `var(--pk-x)` token in the first rule whose selector is `sel`. */
function decl(sel: string, prop: string): string {
  const esc = sel.replace(/[.>]/g, (c) => `\\${c}`);
  const rule = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? '';
  const m = new RegExp(`(?:^|[;\\s])${prop}:\\s*var\\(--pk-([a-z-]+)\\)`).exec(rule);
  if (!m) throw new Error(`no ${prop} token in ${sel}`);
  return m[1] ?? '';
}

describe('text contrast, light and dark', () => {
  const themes = {
    dark: /:root,\[data-theme="dark"\]\{([^}]*)\}/.exec(tokens)?.[1] ?? '',
    light: /\[data-theme="light"\]\{color-scheme:light;([^}]*)\}/.exec(tokens)?.[1] ?? '',
  };
  /** Resolves a token to hex, following one level of var() aliasing. */
  const hex = (block: string, token: string): string => {
    const m =
      new RegExp(`--pk-${token}:([^;]+);`).exec(block)?.[1] ??
      new RegExp(`--pk-${token}:(var\\(--pk-[a-z-]+\\));`).exec(tokens)?.[1] ??
      '';
    const alias = /^var\(--pk-([a-z-]+)\)$/.exec(m);
    return alias ? hex(block, alias[1] ?? '') : m;
  };
  const washes = [...css.matchAll(/--dg-fill:\s*var\(--pk-([a-z-]+)\)/g)].map((m) => m[1] ?? '');
  // Each text style is read from the CSS and checked on the surface(s) it is drawn on.
  const pairs: [string, string, string][] = [
    ...washes.flatMap((w): [string, string, string][] => [
      ['.dg-note', 'fill', w],
      ['.dg-name', 'fill', w],
    ]),
    ...['surface-raised', 'surface-sunken'].flatMap((bg): [string, string, string][] => [
      ['.dg-label', 'fill', bg],
      ['.dg-call', 'fill', bg],
      ['.dg-num', 'fill', bg],
    ]),
  ];
  const named: [string, string, string, string][] = [
    ['.dg-notetext', 'fill', '.dg-notebox', 'fill'],
    ['.dg-tabtext', 'fill', '.dg-tab', 'fill'],
    ['.dg-num', 'fill', '.dg-num-bg', 'fill'],
    ['.dg-aside', 'color', '.dg-aside', 'background'],
    ['.dg-who', 'color', '.dg-grp', 'surface-raised'],
  ];
  for (const [theme, block] of Object.entries(themes)) {
    for (const [sel, prop, bg] of pairs) {
      it(`${sel} on ${bg} in ${theme}`, () => {
        const fg = hex(block, decl(sel, prop));
        expect(contrast(fg, hex(block, bg))).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const [sel, prop, bgSel, bgProp] of named) {
      it(`${sel} on ${bgSel} in ${theme}`, () => {
        const bg = bgProp.startsWith('surface') ? bgProp : decl(bgSel, bgProp);
        expect(contrast(hex(block, decl(sel, prop)), hex(block, bg))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  it('knows every tone', () => {
    for (const t of TONES) expect(css).toContain(`.dg-tone-${t}`);
  });
});

describe('accessibility', () => {
  it.each(names)('%s names the drawing and offers the list', (name) => {
    const spec = parseDiagram(load(name));
    const html = renderDiagram(name, spec);
    expect(html).toContain('role="img"');
    expect(html).toContain(`aria-labelledby="dg-${name}-title"`);
    expect(html).toContain(`aria-describedby="dg-${name}-desc"`);
    expect(html).toContain(`aria-details="dg-${name}-list"`);
    expect(html).toContain(`<ol id="dg-${name}-list" role="list"`);
    for (const m of html.matchAll(/<(?:ol|ul) class="dg-(?:sub|outs)"/g)) {
      expect(html.slice(m.index, m.index + 60)).toContain('role="list"');
    }
    expect(html).toContain(`<title id="dg-${name}-title">`);
    expect(html).toContain(`aria-label="${spec.title.replace(/"/g, '&quot;')}"`);
  });
});

describe('pass-lifecycle', () => {
  const spec = parseDiagram(load('pass-lifecycle'));

  it('keeps the lifecycle text, mermaid and calls the old renderer had', () => {
    expect(spec.desc).toBe(LIFECYCLE_DESC);
    expect(diagramMermaid(spec)).toBe(lifecycleMermaid());
    const svg = diagramSvg('pass-lifecycle', spec);
    for (const call of new Set(EDGES.map((e) => e.call))) expect(svg).toContain(`>${call}<`);
  });

  it('snapshots the figure, the list and the mermaid', async () => {
    const html = renderDiagram('pass-lifecycle', spec);
    await expect(html).toMatchFileSnapshot('__snapshots__/pass-lifecycle.figure.txt');
    await expect(diagramMermaid(spec)).toMatchFileSnapshot('__snapshots__/pass-lifecycle.mmd');
  });
});

describe('checkout-to-pass', () => {
  const spec = parseDiagram(load('checkout-to-pass'));

  it('writes sequence mermaid with replies, notes and the group', () => {
    const m = diagramMermaid(spec);
    expect(m).toContain('sequenceDiagram');
    expect(m).toContain('app->>pb: POST /passes');
    expect(m).toContain('pb-->>app: 201 pass');
    expect(m).toContain('Note over app,pb: Idempotency-Key: order id');
    expect(m).toContain('  opt Webhook retried');
  });

  it('numbers the steps 1 to 8 in both layouts', () => {
    const html = renderDiagram('checkout-to-pass', spec);
    for (let i = 1; i <= 8; i++) {
      expect(html).toContain(`<text class="dg-num" x="23" y="`);
      expect(html).toMatch(new RegExp(`class="dg-num"[^>]*>${i}</text>`));
      expect(html).toContain(`<span class="dg-n">${i}</span>`);
    }
    expect(html).not.toMatch(/class="dg-num"[^>]*>9<\/text>/);
  });
});

describe('layout checks', () => {
  const flow = () => structuredClone(load('pass-lifecycle'));

  it('measures a vertical edge label against the room to its right', () => {
    const f = flow();
    f.edges[6].quiet = false;
    f.edges[6].label = 'M'.repeat(24);
    expect(() => diagramSvg('x', parseDiagram(f))).toThrow(/box holds/);
  });

  it('throws when a same-row edge crosses a middle node', () => {
    const f = flow();
    f.edges.push({ from: 'voided', to: 'removed', label: 'skip' });
    expect(() => diagramSvg('x', parseDiagram(f))).toThrow(/runs through node "active"/);
  });

  it('throws when a vertical edge skips a row through a node', () => {
    const f = flow();
    f.nodes.push({ id: 'mid', label: 'Mid', col: 1, row: 1 });
    f.nodes[3].row = 2;
    f.nodes[3].col = 0;
    expect(() => diagramSvg('x', parseDiagram(f))).toThrow(/runs through node "mid"/);
  });

  it('puts an up/down pair between two rows in two lanes', () => {
    const f = flow();
    f.edges.push({ from: 'deleted', to: 'active', label: 'undo' });
    const svg = diagramSvg('x', parseDiagram(f));
    expect(svg).toContain('text-anchor="end">DELETE');
    expect(svg).toContain('text-anchor="start">undo');
  });

  it('measures actor labels at the size they are drawn', () => {
    const s = load('checkout-to-pass');
    s.actors[0].label = 'W'.repeat(14);
    expect(() => diagramSvg('x', parseDiagram(s))).toThrow(/box holds/);
  });

  it('fails when a drawing cannot fit the widest container tier', () => {
    const s = load('checkout-to-pass');
    s.actors.push({ id: 'e', label: 'Fifth lane' }, { id: 'f', label: 'Sixth lane' });
    s.steps.push({ from: 'shop', to: 'f', label: 'M'.repeat(60) });
    expect(() => diagramSvg('x', parseDiagram(s))).toThrow(DiagramError);
  });

  it('ties the tiers to the CSS container rules', () => {
    const rules = [...css.matchAll(/@container dg \(max-width: ([\d.]+)px\)\s*\{\s*\.dg-t(\d+) /g)];
    expect(rules.map((m) => [Math.round(Number(m[1])), Number(m[2])])).toEqual(
      TIERS.map((t) => [t, t]),
    );
  });
});

describe('colour words', () => {
  const NAMED =
    /\b(?:red|blue|green|black|white|gray|grey|orange|yellow|purple|pink|teal|navy|cyan|magenta|brown|gold|silver|lime|maroon|olive|aqua|coral|crimson|indigo|violet)\b/i;
  it('are not used as values in the CSS', () => {
    const values = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/:\s*([^;{}]+);/g)].map(
      (m) => m[1] ?? '',
    );
    for (const v of values) expect(v.replace(/var\([^)]*\)/g, ''), v).not.toMatch(NAMED);
  });
  it('are not used as fill or stroke in the SVG', () => {
    for (const name of names) {
      const html = renderDiagram(name, parseDiagram(load(name)));
      expect(html).not.toMatch(
        /(?:fill|stroke|color)\s*[=:]\s*"?(?:red|blue|green|black|white|gray|grey)/i,
      );
    }
  });
});

describe('mermaid escaping', () => {
  it('escapes pipes and uses declared states for reserved or repeated labels', () => {
    const f = parseDiagram({
      title: 'T',
      desc: 'D',
      kind: 'flow',
      mermaid: 'state',
      nodes: [
        { id: 'a', label: 'End', col: 0, row: 0 },
        { id: 'b', label: 'Same', col: 1, row: 0 },
        { id: 'c', label: 'same', col: 2, row: 0 },
      ],
      edges: [{ from: 'a', to: 'b', label: 'a | b' }],
    });
    const m = diagramMermaid(f);
    expect(m).toContain('state "End" as a');
    expect(m).toContain('state "Same" as b');
    expect(m).toContain('a --> b: a #124; b');
    const fc = diagramMermaid(parseDiagram({ ...f, mermaid: 'flowchart' }));
    expect(fc).toContain('-->|a #124; b|');
  });
});
