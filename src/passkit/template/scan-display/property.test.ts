import { describe, expect, it } from 'vitest';
import { ScanDisplaySchema } from '../../../shared/contracts/scan-display.ts';
import { DENSITY } from './density.ts';
import { renderedUnits } from './render-rows.ts';
import { ScanDisplayDocSchema } from './schema.ts';
import { NOW, renderDoc, scopeOf } from './test-kit.ts';

let seed = 42;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)] as T;
const chance = (p: number) => rnd() < p;
const WORDS = [
  'VIP',
  'Row F',
  'Lounge',
  'Welcome back',
  '👨‍👩‍👧 family',
  'é combining',
  'x'.repeat(60),
  '{{inputs.a}}',
  '{{inputs.b|upper}}',
  '{{inputs.missing}}',
  '{{history.lastVisit.at|ago}}',
  '{{inputs.n|count}}',
  '{{inputs.when|day}}',
];
const text = (cap = 40) => pick(WORDS).slice(0, cap);
let counter = 0;
const id = (prefix: string) => `${prefix}_${(counter++).toString(36)}`;
const chip = () => ({
  id: id('c'),
  text: text(16),
  tone: pick(['neutral', 'teal', 'violet', 'gold'] as const),
});
const some = (max: number) => 1 + Math.floor(rnd() * max);

function row(): object {
  const type = pick([
    'heading',
    'field',
    'big',
    'columns',
    'progress',
    'money',
    'history',
    'chips',
    'list',
    'note',
    'divider',
  ] as const);
  const base = { id: id('r'), type };
  switch (type) {
    case 'heading':
      return { ...base, text: text(24) };
    case 'field':
      return {
        ...base,
        label: text(20),
        value: text(),
        whenEmpty: pick(['hide', 'dash'] as const),
      };
    case 'big':
      return { ...base, value: text(12), unit: chance(0.5) ? text(12) : undefined };
    case 'columns':
      return {
        ...base,
        size: pick(['big', 'normal'] as const),
        items: Array.from({ length: 1 + some(3) }, () => ({
          id: id('i'),
          label: text(12),
          value: text(16),
        })),
      };
    case 'progress':
      return { ...base, value: '{{inputs.n}}', goal: pick([5, 10, 50]), reward: text(24) };
    case 'money':
      return { ...base, amount: '{{inputs.n}}', currency: 'USD', lowBelow: 5 };
    case 'history':
      return {
        ...base,
        source: pick(['value', 'visits', 'scans'] as const),
        input: 'n',
        limit: some(5),
      };
    case 'chips':
      return { ...base, items: Array.from({ length: some(4) }, chip) };
    case 'list':
      return {
        ...base,
        pair: chance(0.5),
        items: Array.from({ length: some(4) }, () => ({
          id: id('i'),
          icon: 'star',
          text: text(32),
        })),
      };
    case 'note':
      return { ...base, text: text(140), tone: pick(['neutral', 'info', 'attention'] as const) };
    default:
      return base;
  }
}

const randomDoc = () => ({
  v: 1,
  holder: chance(0.7) ? '{{inputs.a}}' : undefined,
  photo: chance(0.3) ? {} : undefined,
  header: {
    title: chance(0.4) ? text(28) : undefined,
    subtitle: chance(0.5) ? text(60) : undefined,
    chips: chance(0.5) ? [chip(), chip()] : undefined,
  },
  panels: Array.from({ length: Math.floor(rnd() * 5) }, () => ({
    id: id('p'),
    title: chance(0.5) ? text(24) : undefined,
    on: chance(0.3) ? [pick(['ready', 'ok', 'heads_up'] as const)] : undefined,
    rows: Array.from({ length: some(6) }, row),
  })),
  notes: { staff: chance(0.3) ? text(140) : undefined },
});

describe('1,000 random docs', () => {
  it('render to a valid ScanDisplay inside the budget, under 5 ms each on average', () => {
    const scope = scopeOf(
      { a: 'Maya Lopez', b: 'x', n: 7, when: NOW },
      {
        history: {
          lastVisit: { at: NOW - 3_600_000 },
          list: {
            visits: [{ at: NOW - 1000, where: 'Door' }],
            scans: [{ at: NOW, label: 'Check in' }],
            value: { n: [{ at: NOW, amount: 2, after: 7, label: 'Add' }] },
          },
        },
        scan: { input: 'n', before: 5, after: 7 },
      },
    );
    let total = 0;
    let renders = 0;
    let docs = 0;
    for (let i = 0; i < 1000; i++) {
      const parsed = ScanDisplayDocSchema.safeParse(JSON.parse(JSON.stringify(randomDoc())));
      if (!parsed.success) continue;
      docs++;
      for (const screen of ['ready', 'ok', 'heads_up', 'refused'] as const) {
        const started = performance.now();
        const out = renderDoc(parsed.data, scope, {
          screen,
          role: pick(['door', 'desk', 'manager'] as const),
        });
        total += performance.now() - started;
        renders++;
        ScanDisplaySchema.parse(out);
        expect(JSON.stringify(out)).not.toContain('{{');
        if (screen === 'refused') expect(out.panels).toEqual([]);
        const cap = DENSITY.result - (screen === 'heads_up' ? DENSITY.header.headsUp : 0);
        const used = out.panels.reduce(
          (sum, p) => sum + 1 + p.rows.reduce((s, r) => s + renderedUnits(r), 0),
          0,
        );
        expect(used <= cap || out.panels.length === 1, `${screen}: ${used} of ${cap}`).toBe(true);
      }
    }
    expect(docs).toBeGreaterThan(500);
    expect(total / renders).toBeLessThan(5);
  }, 60_000);
});
