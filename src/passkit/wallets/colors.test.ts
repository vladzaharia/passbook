import { beforeAll, describe, expect, it } from 'vitest';
import { loadBaked } from '../template/baked-fixtures.ts';
import { googleCompiler } from './google/compilers.ts';
import { googleView } from './google/fixtures.ts';
import { attributes, compile, NOW, view } from './samsung/fixtures.ts';

beforeAll(async () => {
  await loadBaked('starter-stamp-card');
}, 120_000);

const COLORS = { background: '#112233', foreground: '#ffeedd', label: '#aabbcc' };

describe('colours on Google and Samsung', () => {
  it('Google sends the background and records foreground and label as differences: it has no such fields', async () => {
    const v = await googleView('starter-stamp-card', {
      patch: (w) => {
        w.colors = { ...COLORS };
      },
    });
    const out = googleCompiler.compile(v, { now: NOW, omit: [] });
    expect(JSON.stringify(out)).toContain('"hexBackgroundColor":"#112233"');
    expect(JSON.stringify(out)).not.toContain('ffeedd');
    expect(JSON.stringify(out)).not.toContain('aabbcc');
    const notes = out.items.filter((i) => i.capability.startsWith('colors.'));
    expect(notes.map((i) => [i.capability, i.support])).toEqual([
      ['colors.foreground', 'difference'],
      ['colors.label', 'difference'],
    ]);
  });

  it('Samsung maps background and foreground and records only the label as a difference', async () => {
    const v = await view('starter-stamp-card');
    v.colors = { ...COLORS };
    const out = compile(v);
    expect(attributes(out)).toMatchObject({ bgColor: '#112233', fontColor: '#ffeedd' });
    expect(JSON.stringify(out)).not.toContain('aabbcc');
    const notes = out.items.filter((i) => i.capability.startsWith('colors.'));
    expect(notes.map((i) => [i.capability, i.support])).toEqual([['colors.label', 'difference']]);
  });
});
