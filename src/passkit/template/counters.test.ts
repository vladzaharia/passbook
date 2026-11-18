import { describe, expect, it } from 'vitest';
import { shippedAssets, stampedName } from '../build-assets.ts';
import { encodePng } from '../stamps/png.ts';
import { counterScope } from '../stamps/rules.ts';
import type { PassJson, Personalization, TemplateManifest } from '../types.ts';
import { bindPass } from './bindings.ts';
import {
  counterSizes,
  countersIssues,
  derivedPassScope,
  stripBlock,
  stripCount,
} from './counters.ts';
import { evaluate, testCondition } from './expr.ts';
import { applyDefaults, projectDisplay, validateManifest } from './manifest.ts';
import { readTemplatePackage } from './package.ts';
import type { ResolvedTemplate } from './registry.ts';
import { unknownPassValues } from './reserved.ts';
import { actionGoals } from './scan-display/scope.ts';

const SIZE = 5;
const manifest = (): TemplateManifest =>
  ({
    schema: 1,
    name: 'Pack',
    inputs: {
      type: 'object',
      properties: {
        holder: { type: 'string' },
        left: { type: 'integer', minimum: 0, maximum: SIZE, default: SIZE },
      },
    },
    sample: { holder: 'Ana' },
    bindings: [
      { to: { field: 'left' }, value: '{{pass.counters.visits.text}}' },
      { to: { field: 'left', prop: 'changeMessage' }, value: '%@' },
    ],
    display: { title: '{{holder}}', status: '{{pass.counters.visits.text}}' },
    counters: { visits: { input: 'left', size: SIZE } },
    scan: {
      actions: [
        { id: 'use', label: 'Use one', kind: 'take', input: 'left', amount: 1 },
        { id: 'refill', label: 'Refill', kind: 'set', input: 'left', value: SIZE },
      ],
    },
  }) as unknown as TemplateManifest;

const withArt = (): TemplateManifest => ({
  ...manifest(),
  counters: {
    visits: {
      input: 'left',
      size: SIZE,
      art: { filled: 'stamps/filled.png', empty: 'stamps/empty.png' },
    },
  },
});

const passJson = (): PassJson =>
  ({ storeCard: { secondaryFields: [{ key: 'left', label: 'Left', value: '' }] } }) as never;

const solid = (rgba: [number, number, number, number]) => {
  const width = 128;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return encodePng({ width, height: width, data } as never);
};

async function resolved(m: TemplateManifest): Promise<ResolvedTemplate> {
  const enc = new TextEncoder();
  const pkg = await readTemplatePackage({
    'wallet.template.json': enc.encode(JSON.stringify(m)),
    'pass.json': enc.encode(JSON.stringify(passJson())),
    'stamps/filled.png': solid([255, 0, 0, 255]),
    'stamps/empty.png': solid([200, 200, 200, 255]),
  });
  return {
    id: 't',
    version: 'v',
    orgId: null,
    origin: 'uploaded',
    manifest: pkg.manifest,
    passJson: pkg.passJson,
    assets: pkg.assets,
    styles: ['storeCard'],
  };
}

const at = (left: number): Personalization => ({ holder: 'Ana', left });

describe('pass.counters scope', () => {
  it('counts what is left, used and the size', () => {
    expect(counterScope(7, 10)).toEqual({
      left: 7,
      used: 3,
      size: 10,
      none: false,
      text: '7 left',
    });
  });
  it('says None left at zero', () => {
    expect(counterScope(0, 10)).toMatchObject({ left: 0, used: 10, none: true, text: 'None left' });
  });
  it('floors at 0, keeps a refill that carries over, and never uses below 0', () => {
    expect(counterScope(-2, 5).left).toBe(0);
    expect(counterScope(9, 5)).toMatchObject({ left: 9, used: 0 });
    expect(counterScope(2.9, 5).left).toBe(2);
  });
  it('reads left, used, size, none and text in expressions and conditions', () => {
    const scope = (n: number) => ({
      input: {},
      lookups: {},
      pass: derivedPassScope(manifest(), at(n)),
    });
    expect(
      evaluate('{{pass.counters.visits.left}} of {{pass.counters.visits.size}}', scope(3)),
    ).toBe('3 of 5');
    expect(evaluate('{{pass.counters.visits.used}}', scope(3))).toBe(2);
    expect(evaluate('{{pass.counters.visits.text}}', scope(0))).toBe('None left');
    const none = { input: 'pass.counters.visits.none', eq: true };
    expect(testCondition(none, scope(1))).toBe(false);
    expect(testCondition(none, scope(0))).toBe(true);
  });
  it('starts full from the input default', () => {
    const full = applyDefaults(manifest(), { holder: 'Ana' });
    expect(derivedPassScope(manifest(), full).counters?.visits?.text).toBe('5 left');
  });
  it('is absent without a block, and knows the name as a pass value', () => {
    const m = { ...manifest() };
    delete m.counters;
    expect(derivedPassScope(m, at(1)).counters).toBeUndefined();
    expect(unknownPassValues('{{pass.counters.visits.left}}', manifest())).toEqual([]);
    expect(unknownPassValues('{{pass.counters.visits.left}}', m)).toEqual(['counters']);
  });
  it('binds into the pass and the passes list', async () => {
    const t = await resolved(manifest());
    const bound = bindPass(t, at(3), derivedPassScope(t.manifest, at(3)));
    const field = (bound.pass.storeCard as { secondaryFields: { value: string }[] })
      .secondaryFields;
    expect(field[0]?.value).toBe('3 left');
    expect(projectDisplay(t.manifest, at(0)).status).toBe('None left');
  });
});

describe('strip per count', () => {
  it('draws the strip from the one counter with art', () => {
    expect(stripBlock(manifest())).toBeUndefined();
    expect(stripBlock(withArt())).toMatchObject({ input: 'left', goal: SIZE });
  });
  it('counts what is left, whole and clamped', () => {
    expect(stripCount(withArt(), at(3))).toBe(3);
    expect(stripCount(withArt(), at(0))).toBe(0);
    expect(stripCount(withArt(), at(9))).toBe(SIZE);
    expect(stripCount(manifest(), at(3))).toBeUndefined();
  });
  it('draws a strip pair for every count and ships only the count left', async () => {
    const t = await resolved(withArt());
    const strips = t.assets.filter((a) => a.stamps !== undefined);
    expect(strips.map((a) => a.stamps)).toEqual(expect.arrayContaining([0, 1, 2, 3, 4, 5]));
    expect(strips).toHaveLength((SIZE + 1) * 2);
    const names = (n: number) => shippedAssets(t, [], {}, n).map((a) => a.name);
    expect(names(3)).toEqual(['strip@2x.png', 'strip@3x.png']);
    expect(shippedAssets(t, [], {}, 3).map((a) => a.source)).toEqual([
      'stamps/strips/3/strip@2x.png',
      'stamps/strips/3/strip@3x.png',
    ]);
    expect(stampedName(t, 'strip@2x.png', 0)).toBe('stamps/strips/0/strip@2x.png');
    expect(stampedName(t, 'strip@3x.png', 9)).toBe('stamps/strips/5/strip@3x.png');
  });
  it('draws nothing without art', async () => {
    const t = await resolved(manifest());
    expect(t.assets.some((a) => a.stamps !== undefined)).toBe(false);
  });
});

describe('scan: use one and refill', () => {
  it('gives a take on a counter its size and no reward', () => {
    expect(counterSizes(manifest())).toEqual({ left: SIZE });
    expect(actionGoals(manifest())).toEqual({ left: { goal: SIZE, counter: true } });
  });
  it('leaves other takes alone', () => {
    const m = { ...manifest(), counters: undefined } as unknown as TemplateManifest;
    expect(actionGoals(m).left).toEqual({ goal: 1 });
  });
});

describe('counters manifest checks', () => {
  const codes = (m: TemplateManifest, names: string[] = []) =>
    countersIssues(m, passJson(), names).map((i) => i.code);
  const edit = (patch: (m: TemplateManifest) => void, base = manifest()) => {
    patch(base);
    return base;
  };
  const prop = (m: TemplateManifest) =>
    (m.inputs.properties as Record<string, Record<string, unknown>>).left as Record<
      string,
      unknown
    >;

  it('accepts a counter, with and without art', () => {
    expect(countersIssues(manifest(), passJson())).toEqual([]);
    expect(countersIssues(withArt(), passJson())).toEqual([]);
    const all = validateManifest(withArt(), { passJson: passJson(), allowPattern: true });
    expect(all.filter((i) => i.code.startsWith('COUNTER') || i.code === 'EXPR_PASS')).toEqual([]);
  });
  it('is silent without a block', () => {
    const m = manifest();
    delete m.counters;
    expect(countersIssues(m)).toEqual([]);
  });
  it('refuses a block that is not an object keyed by id', () => {
    expect(codes(edit((m) => (m.counters = [] as never)))).toContain('COUNTERS_SHAPE');
    expect(codes(edit((m) => (m.counters = { Bad: { input: 'left', size: 5 } })))).toContain(
      'COUNTER_ID',
    );
  });
  it('allows at most four counters', () => {
    const m = edit((x) => {
      x.counters = Object.fromEntries(
        'abcde'.split('').map((id) => [id, { input: `n${id}`, size: 5 }]),
      );
    });
    expect(codes(m)).toContain('COUNTERS_SHAPE');
  });
  it.each([0, 1001, 2.5, '5'])('refuses size %s', (size) => {
    expect(
      codes(
        edit(
          (m) => ((m.counters as never as Record<string, { size: unknown }>).visits!.size = size),
        ),
      ),
    ).toContain('COUNTER_SIZE');
  });
  it('wants an integer input from 0 to size', () => {
    expect(
      codes(
        edit(
          (m) =>
            ((m.counters as never as Record<string, { input: string }>).visits!.input = 'nope'),
        ),
      ),
    ).toContain('COUNTER_INPUT');
    expect(
      codes(
        edit(
          (m) =>
            ((m.counters as never as Record<string, { input: string }>).visits!.input = 'holder'),
        ),
      ),
    ).toContain('COUNTER_INPUT');
    expect(codes(edit((m) => (prop(m).maximum = SIZE - 1)))).toContain('COUNTER_INPUT');
    expect(codes(edit((m) => (prop(m).maximum = SIZE + 1)))).not.toContain('COUNTER_INPUT');
    expect(codes(edit((m) => delete prop(m).maximum))).not.toContain('COUNTER_INPUT');
    expect(codes(edit((m) => (prop(m).minimum = 1)))).toContain('COUNTER_INPUT');
  });
  it('refuses one input for two counters and for stamps', () => {
    const two = edit((m) => {
      m.counters = { a: { input: 'left', size: SIZE }, b: { input: 'left', size: SIZE } };
    });
    expect(codes(two)).toContain('COUNTER_INPUT');
    const both = edit((m) => {
      m.stamps = { input: 'left', goal: SIZE, art: { filled: 'x', empty: 'y' } };
    });
    expect(codes(both)).toContain('COUNTER_INPUT');
  });
  it('reads a missing input as 0 whatever the default', () => {
    const m = edit((x) => delete prop(x).default);
    expect(codes(m)).not.toContain('COUNTER_DEFAULT');
    expect(derivedPassScope(m, applyDefaults(m, { holder: 'Ana' })).counters?.visits).toMatchObject(
      {
        left: 0,
        text: 'None left',
      },
    );
    expect(
      stripCount(
        edit((x) => delete prop(x).default, withArt()),
        { holder: 'Ana' },
      ),
    ).toBe(0);
  });
  it('wants art as stamps/ PNGs, one strip, a strip size and a style with a strip', () => {
    const art = (m: TemplateManifest) => m.counters as never as Record<string, { art: unknown }>;
    expect(
      codes(edit((m) => (art(m).visits!.art = { filled: 'a.png', empty: 'b.png' }), withArt())),
    ).toContain('COUNTER_ART');
    expect(
      codes(
        edit(
          (m) => ((m.counters as never as Record<string, { size: number }>).visits!.size = 2),
          withArt(),
        ),
      ),
    ).toContain('COUNTER_STRIP_SIZE');
    const two = withArt();
    (two.inputs.properties as Record<string, unknown>).other = {
      type: 'integer',
      minimum: 0,
      maximum: 5,
      default: 5,
    };
    (two.counters as never as Record<string, unknown>).second = {
      input: 'other',
      size: 5,
      art: { filled: 'stamps/filled.png', empty: 'stamps/empty.png' },
    };
    expect(codes(two)).toContain('COUNTER_STRIP');
    const stamped = edit((m) => {
      m.stamps = { input: 'holder', goal: 5, art: { filled: 'x', empty: 'y' } };
    }, withArt());
    expect(codes(stamped)).toContain('COUNTER_STRIP');
    expect(codes(withArt(), ['en.lproj/strip@2x.png'])).toContain('COUNTER_LOCALIZED');
    expect(countersIssues(withArt(), { generic: {} } as never).map((i) => i.code)).toContain(
      'COUNTER_STYLE',
    );
  });
  it('takes any value up to the input maximum for a set, and a staff-entered one', () => {
    const set = (value?: unknown) =>
      edit((m) => {
        m.scan = {
          actions: [
            {
              id: 'r',
              label: 'Refill',
              kind: 'set',
              input: 'left',
              ...(value === undefined ? {} : { value }),
            },
          ],
        } as never;
      });
    expect(codes(set())).not.toContain('SCAN_COUNTER_VALUE');
    expect(codes(set(SIZE))).not.toContain('SCAN_COUNTER_VALUE');
    expect(codes(set(SIZE + 1))).toContain('SCAN_COUNTER_VALUE');
    expect(codes(set(-1))).toContain('SCAN_COUNTER_VALUE');
  });
  it('warns, softly, when nothing at the scanner takes from the counter', () => {
    expect(codes(edit((m) => delete m.scan))).toContain('COUNTER_NO_USE');
    expect(codes(manifest())).not.toContain('COUNTER_NO_USE');
  });
});

describe('a per-pass size and a refill that carries over', () => {
  // Pack: 0 to 200 uses, 10 or 20 per pass, refills add to what is left.
  const pack = (): TemplateManifest => {
    const m = manifest();
    m.inputs = {
      type: 'object',
      properties: {
        holder: { type: 'string' },
        left: { type: 'integer', minimum: 0, maximum: 200, default: 10 },
        size: { type: 'integer', minimum: 1, maximum: 200, default: 10 },
      },
    } as never;
    m.counters = { uses: { input: 'left', size: { input: 'size' } } };
    m.scan = {
      actions: [
        { id: 'use', label: 'Use one', kind: 'take', input: 'left', amount: 1 },
        { id: 'refill', label: 'Refill', kind: 'add', input: 'left', amount: { max: 100 } },
      ],
    } as never;
    return m;
  };
  it('accepts it, without strip art', () => {
    expect(countersIssues(pack(), passJson())).toEqual([]);
  });
  it('reads size per pass, and used never goes below 0', () => {
    const scope = (left: number, size: number) =>
      derivedPassScope(pack(), { holder: 'A', left, size }).counters?.uses;
    expect(scope(7, 10)).toMatchObject({ left: 7, used: 3, size: 10 });
    expect(scope(23, 10)).toMatchObject({ left: 23, used: 0, text: '23 left' });
    expect(scope(5, 20)).toMatchObject({ used: 15, size: 20 });
  });
  it('gives the row the size input default as its goal', () => {
    expect(actionGoals(pack())).toEqual({ left: { goal: 10, counter: true } });
  });
  it('refuses art with a per-pass size, and a size input that is not an integer', () => {
    const art = { filled: 'stamps/filled.png', empty: 'stamps/empty.png' };
    const withPackArt = pack();
    (withPackArt.counters as never as Record<string, { art: unknown }>).uses!.art = art;
    expect(countersIssues(withPackArt, passJson()).map((i) => i.code)).toContain(
      'COUNTER_STRIP_SIZE',
    );
    expect(stripBlock(withPackArt)).toBeUndefined();
    const bad = pack();
    (bad.counters as never as Record<string, { size: unknown }>).uses!.size = { input: 'holder' };
    expect(countersIssues(bad, passJson()).map((i) => i.code)).toContain('COUNTER_SIZE');
  });
  // Guest admits: 0 to 99, default 0, no size worth showing.
  it('allows a count that starts at 0', () => {
    const m = pack();
    const props = m.inputs.properties as Record<string, Record<string, unknown>>;
    props.left = { type: 'integer', minimum: 0, maximum: 99, default: 0 };
    m.counters = { guests: { input: 'left', size: 99 } };
    expect(countersIssues(m, passJson())).toEqual([]);
    expect(derivedPassScope(m, applyDefaults(m, {})).counters?.guests?.text).toBe('None left');
  });
});

describe('references and messages', () => {
  const refs = (expr: string, m = manifest()) => unknownPassValues(expr, m);
  it('checks the id and the leaf of a counter reference', () => {
    expect(refs('{{pass.counters.visits.left}}')).toEqual([]);
    expect(refs('{{pass.counters.vists.left}}')).toEqual(['counters.vists.left']);
    expect(refs('{{pass.counters.visits.nope}}')).toEqual(['counters.visits.nope']);
    expect(refs('{{pass.counters.visits}}')).toEqual(['counters.visits']);
  });
  it('tells holders when what is left changes, unless the template says otherwise', async () => {
    const t = await resolved(manifest());
    t.manifest.bindings = [{ to: { field: 'left' }, value: '{{pass.counters.visits.text}}' }];
    const field = (n: number, m = t) =>
      (
        bindPass(m, at(n), derivedPassScope(m.manifest, at(n))).pass.storeCard as {
          secondaryFields: { changeMessage?: string }[];
        }
      ).secondaryFields[0]?.changeMessage;
    expect(field(3)).toBe('%@.');
    const left = structuredClone(t);
    left.manifest.bindings = [{ to: { field: 'left' }, value: '{{pass.counters.visits.left}}' }];
    expect(field(3, left)).toBe('%@ left.');
    const own = structuredClone(left);
    (own.passJson.storeCard as { secondaryFields: object[] }).secondaryFields[0] = {
      key: 'left',
      value: '',
      changeMessage: 'Now %@',
    };
    expect(field(3, own)).toBe('Now %@');
  });
});
