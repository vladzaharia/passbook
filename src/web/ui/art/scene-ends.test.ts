import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCENES = join(process.cwd(), 'src/web/ui/art/scenes');
const css = (f: string) => readFileSync(join(SCENES, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level blocks: [prelude, body]. */
function blocks(text: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let start = 0;
  let open = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) open = i;
      depth++;
    } else if (text[i] === '}' && --depth === 0) {
      out.push([text.slice(start, open).trim(), text.slice(open + 1, i)]);
      start = i + 1;
    }
  }
  return out;
}

const keyframes = (f: string) =>
  new Map(
    blocks(css(f))
      .filter(([sel]) => sel.startsWith('@keyframes '))
      .map(([sel, body]) => [sel.slice(11), blocks(body)] as const),
  );
const REST: Record<string, string> = { translate: '0 0', rotate: '0deg', scale: '1', opacity: '1' };

describe('nudge, list, stage and miniature scenes', () => {
  // Each one ends on the pose that rest.css and the art draw, so nothing jumps when it stops.
  it('end every animation at rest', () => {
    for (const f of ['nudge.css', 'tuck.css', 'count.css', 'face.css', 'wave.css']) {
      for (const [name, frames] of keyframes(f)) {
        const end = frames.find(([sel]) => sel.split(',').some((s) => s.trim() === '100%'));
        if (!end) continue;
        for (const decl of end[1].split(';')) {
          const [prop = '', value] = decl.split(':').map((s) => s.trim());
          if (prop) expect(value, `${f} ${name} ${prop}`).toBe(REST[prop]);
        }
      }
    }
  });

  // The owner: "I like the 'falling onto the card' idea." Unseen until it runs, then it drops.
  it('drop the nudge onto the card: impact at 11%, the squash, spread and blink right after', () => {
    expect(css('rest.css')).toMatch(/\[data-scene="nudge"\]:not\(\[data-run\]\) \{\s*opacity: 0;/);
    const nudge = keyframes('nudge.css');
    const fall = nudge.get('wl-s-nudge-fall') ?? [];
    expect(fall[0]?.[1]).toMatch(
      /translate: 0 calc\(var\(--wl-drop, 48px\) \* -1\);\s*opacity: 0;/,
    );
    expect(fall.at(-1)?.[0]).toMatch(/^11%,\s*100%$/);
    const at = (name: string, sel: string) =>
      nudge
        .get(name)
        ?.find(([s]) => s.replace(/\s+/g, ' ') === sel)?.[1]
        .replace(/\s+/g, ' ');
    expect(at('wl-s-nudge-land', '13.5%')).toMatch(/scale: 1\.14 0\.83/);
    expect(at('wl-s-nudge-shadow', '13.5%')).toMatch(/scale: 1\.14 1/);
    expect(at('wl-s-nudge-blink', '12.5%')).toMatch(/scale: 1 0\.15/);
    // Then the teal pass lifts out of the pocket and aims up-left at the badge, twice (B3); a
    // seat steeper below its badge scales the turn and moves the look (portal.css).
    expect(at('wl-s-nudge-point', '48%, 56%, 62%')).toMatch(
      /translate: -3px -10px; rotate: calc\(var\(--wl-aim, 1\) \* -24deg\)/,
    );
    expect(at('wl-s-nudge-point', '52%')).toMatch(
      /translate: -2px -7px; rotate: calc\(var\(--wl-aim, 1\) \* -16deg\)/,
    );
    expect(at('wl-s-nudge-look', '40%, 68%')).toMatch(/translate: var\(--wl-look, -2.2px -1.2px\)/);
    // 2.6 s from the landed art (700 ms): still by 3.3 s.
    const runs = [...css('nudge.css').matchAll(/animation: wl-s-nudge-\w+ ([\d.]+)s/g)];
    expect(runs.length).toBe(11);
    for (const [, s] of runs) expect(Number(s)).toBe(2.6);
  });

  it('wink the miniature on a click under a name of its own, so it restarts', () => {
    const face = css('face.css');
    expect(face).toMatch(
      /\[data-scene="wink"\]\[data-run\] \[data-wink\] \{\s*animation: wl-s-face-wink/,
    );
    expect(keyframes('face.css').has('wl-s-face-wink')).toBe(true);
  });
});

// BX1: the portal's scenes. Each ends where the art rests, plays 3.2 s at most, moves only
// transform and opacity, and runs only when motion is welcome (reduced motion holds the final pose).
describe('portal scenes: listen, catch, explain and the face hop', () => {
  const FILES = ['listen.css', 'catch.css', 'explain.css', 'face.css'];
  const MOVES = new Set(['translate', 'rotate', 'scale', 'opacity', 'transform']);
  // The catch envelope is hidden at rest (buddy-art.tsx), so it ends transparent.
  const rest = (name: string, prop: string) =>
    name === 'wl-s-catch-env' && prop === 'opacity' ? '0' : REST[prop];
  const own = (f: string, name: string) =>
    f === 'face.css' ? name === 'wl-s-face-hop' : name.startsWith(`wl-s-${f.replace('.css', '')}-`);

  it('end every animation at rest, with a closing frame', () => {
    for (const f of FILES) {
      for (const [name, frames] of keyframes(f)) {
        if (!own(f, name)) continue;
        const end = frames.find(([sel]) => sel.split(',').some((x) => x.trim() === '100%'));
        expect(end, `${f} ${name} has no 100% frame`).toBeDefined();
        for (const decl of (end?.[1] ?? '').split(';')) {
          const [prop = '', value] = decl.split(':').map((x) => x.trim());
          if (prop && prop !== 'animation-timing-function')
            expect(value, `${f} ${name} ${prop}`).toBe(rest(name, prop));
        }
      }
    }
  });

  it('move only transform and opacity', () => {
    for (const f of FILES) {
      for (const [name, frames] of keyframes(f)) {
        if (!own(f, name)) continue;
        for (const [, body] of frames)
          for (const decl of body.split(';')) {
            const prop = decl.split(':')[0]?.trim();
            if (prop && prop !== 'animation-timing-function')
              expect(MOVES.has(prop), `${f} ${name} ${prop}`).toBe(true);
          }
      }
    }
  });

  it('run once, 3.2 s at most, and only where motion is welcome', () => {
    const scenes = { 'listen.css': 1.6, 'catch.css': 1.8, 'explain.css': 2.2 };
    for (const [f, total] of Object.entries(scenes)) {
      const text = css(f);
      const runs = [...text.matchAll(/animation: (wl-s-[\w-]+) ([\d.]+)s [^;]*;/g)];
      expect(runs.length, f).toBeGreaterThan(0);
      for (const [decl, name, s] of runs) {
        expect(Number(s), `${f} ${name}`).toBe(total);
        expect(Number(s)).toBeLessThanOrEqual(3.2);
        expect(decl).not.toMatch(/infinite|\d+ ?(?:alternate)/);
        expect(keyframes(f).has(name ?? ''), `${f} ${name} keyframes`).toBe(true);
      }
      // Every animation sits inside the no-preference block.
      const outside = blocks(text)
        .filter(([sel]) => !sel.includes('prefers-reduced-motion: no-preference'))
        .map(([, body]) => body)
        .join('\n');
      expect(outside, f).not.toMatch(/animation:/);
    }
    const hop = css('face.css').match(
      /data-scene="hop"\]\[data-run\] \[data-body\] \{\s*animation: wl-s-face-hop (\d+)ms/,
    );
    expect(Number(hop?.[1])).toBe(480);
  });

  it('are in the scene union, and catch draws a hidden envelope', () => {
    const art = readFileSync(join(process.cwd(), 'src/web/ui/art/buddy-art.tsx'), 'utf8');
    for (const name of ['listen', 'catch', 'explain']) expect(art).toContain(`| '${name}'`);
    expect(art).toMatch(/data-env="" opacity="0"/);
  });
});
