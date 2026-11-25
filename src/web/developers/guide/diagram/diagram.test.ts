import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EDGES, LIFECYCLE_DESC, lifecycleMermaid } from '../lifecycle.ts';
import { DiagramError, diagramMermaid, diagramSvg, parseDiagram, renderDiagram } from './index.ts';
import { diagramSpec, TONES } from './spec.ts';

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
  it('has at least the lifecycle and the issue-on-purchase example', () => {
    expect(names).toContain('pass-lifecycle');
    expect(names).toContain('issue-on-purchase');
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
  const seq = () => structuredClone(load('issue-on-purchase'));
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
    const s = load('issue-on-purchase');
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

describe('text contrast, light and dark', () => {
  const themes = {
    dark: /:root,\[data-theme="dark"\]\{([^}]*)\}/.exec(tokens)?.[1] ?? '',
    light: /\[data-theme="light"\]\{color-scheme:light;([^}]*)\}/.exec(tokens)?.[1] ?? '',
  };
  const pick = (block: string, token: string) =>
    new RegExp(`--pk-${token}:(#[0-9a-f]{6})`).exec(block)?.[1] ?? '';
  const fills: Record<string, string> = {
    'surface-page': 'text-muted',
    'success-subtle': 'text-muted',
    'warning-subtle': 'text-muted',
    'info-subtle': 'text-default',
    'danger-subtle': 'text-muted',
    'service-core-subtle': 'text-muted',
    'surface-raised': 'text-default',
    'surface-sunken': 'text-muted',
  };
  for (const [theme, block] of Object.entries(themes)) {
    for (const [fill, text] of Object.entries(fills)) {
      it(`${text} on ${fill} in ${theme}`, () => {
        expect(pick(block, fill), fill).toBeTruthy();
        expect(contrast(pick(block, text), pick(block, fill))).toBeGreaterThanOrEqual(4.5);
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
    expect(html).toContain(`aria-labelledby="dg-${name}-title dg-${name}-desc"`);
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
    await expect(html).toMatchFileSnapshot('__snapshots__/pass-lifecycle.html');
    await expect(diagramMermaid(spec)).toMatchFileSnapshot('__snapshots__/pass-lifecycle.mmd');
  });
});

describe('issue-on-purchase', () => {
  const spec = parseDiagram(load('issue-on-purchase'));

  it('writes sequence mermaid with replies, notes and the group', () => {
    const m = diagramMermaid(spec);
    expect(m).toContain('sequenceDiagram');
    expect(m).toContain('app->>pb: POST /passes');
    expect(m).toContain('pb-->>app: 201 pass');
    expect(m).toContain('Note over app,pb: Idempotency-Key: order id');
    expect(m).toContain('  opt Webhook retried');
  });

  it('numbers the steps 1 to 8 in both layouts', () => {
    const html = renderDiagram('issue-on-purchase', spec);
    for (let i = 1; i <= 8; i++) {
      expect(html).toContain(`class="dg-num"`);
      expect(html).toContain(`<span class="dg-n">${i}</span>`);
    }
  });
});
