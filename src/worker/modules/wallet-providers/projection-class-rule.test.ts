// R2-M1: Google class fields may depend only on template values and the class key's inputs.
import { afterEach, describe, expect, it } from 'vitest';
import { googleCompiler } from '../../../passkit/wallets/google/compilers.ts';
import type { CompileResult } from '../../../passkit/wallets/types.ts';
import { getVersion } from '../templates/repo.ts';
import {
  classProbes,
  conditionLiterals,
  MAX_PROBE_COMPILES,
  withClassRule,
} from './projection-class-rule.ts';
import { computeProjectionPins } from './projection-pins.ts';
import { installV2Env, setup } from './projection-v2-test-fixtures.ts';

installV2Env();
let undo: (() => void) | undefined;
afterEach(() => undo?.());

/** A compiler whose class body reads the first field's text, as a template mapping pass data would. */
function classReads(read: (text: string) => string): void {
  const { compile } = googleCompiler;
  googleCompiler.compile = (view, options): CompileResult => {
    const result = compile(view, options);
    const text = view.fields[0]?.text ?? '';
    return {
      ...result,
      classBody: { ...(result.classBody as object), eventName: read(text) },
    };
  };
  undo = () => {
    googleCompiler.compile = compile;
  };
}

describe('the class field rule at release review', () => {
  it('blocks a design whose class fields move with pass data, with the reason', async () => {
    classReads((text) => text);
    const kit = await setup();
    const version = await getVersion(kit.ctx.env.DB, kit.templateId, kit.version);
    if (!version) throw new Error('Version missing.');
    const { report } = await computeProjectionPins(kit.ctx, 'google', version);
    expect(report.status.kind).toBe('blocked');
    expect(JSON.stringify(report)).toContain('depend on pass data');
  });

  it('passes a design whose class fields are template constants', async () => {
    classReads(() => 'Gala');
    const kit = await setup();
    const version = await getVersion(kit.ctx.env.DB, kit.templateId, kit.version);
    if (!version) throw new Error('Version missing.');
    const { report } = await computeProjectionPins(kit.ctx, 'google', version);
    expect(report.status.kind).not.toBe('blocked');
  });
});

describe('the class field rule, input by input', () => {
  /** A view that carries its input; the compiler reads the class body from a function of it. */
  const run = (
    inputs: object,
    sample: Record<string, never>,
    classOf: (input: Record<string, unknown>) => unknown,
    options: {
      classKey?: string;
      lookups?: Record<string, unknown>;
      literals?: Record<string, never[]>;
      build?: (input: Record<string, unknown>) => void;
    } = {},
  ) => {
    const viewFor = (input: Record<string, unknown>) => {
      options.build?.(input);
      return { input } as never;
    };
    const compiler = {
      target: 'google',
      revision: 1,
      compile: (view: { input: Record<string, unknown> }) => ({
        type: 'event',
        items: [],
        classBody: classOf(view.input),
        objectBody: {},
      }),
    } as never;
    const ruled = withClassRule(
      compiler,
      classProbes(inputs, sample, options.classKey, viewFor, {
        ...(options.lookups ? { lookups: options.lookups } : {}),
        ...(options.literals ? { literals: options.literals } : {}),
      }),
    );
    return ruled.compile(viewFor(sample), { now: new Date(), omit: [] });
  };
  const schema = (properties: object, required: string[] = []) => ({
    type: 'object',
    properties,
    required,
  });

  it('blocks an optional input that is absent from the sample', () => {
    const result = run(schema({ venue: { type: 'string' } }), {}, (input) => ({
      venue: input.venue ?? 'Main hall',
    }));
    expect(result.blocked).toMatchObject({ code: 'CLASS_FIELDS_VARY' });
    expect(result.blocked?.message).toContain('venue');
  });

  it('blocks a boolean, and a list a behaviour reads', () => {
    expect(
      run(schema({ vip: { type: 'boolean' } }), { vip: false } as never, (i) => ({
        name: i.vip ? 'VIP Gala' : 'Gala',
      })).blocked?.code,
    ).toBe('CLASS_FIELDS_VARY');
    expect(
      run(
        schema({ events: { type: 'array', items: { type: 'object' } } }),
        { events: [{ name: 'Gala', date: '2030-05-01' }] } as never,
        (i) => ({ name: (i.events as { name: string }[])[0]?.name }),
      ).blocked?.code,
    ).toBe('CLASS_FIELDS_VARY');
  });

  it('blocks a date input, which moves a day instead of failing to build', () => {
    const result = run(
      schema({ day: { type: 'string', format: 'date' } }, ['day']),
      { day: '2030-05-01' } as never,
      (i) => ({ date: i.day }),
      {
        build: (i) => {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(i.day))) throw new Error('bad date');
        },
      },
    );
    expect(result.blocked?.message).toContain('day');
  });

  it('blocks an input it cannot check, rather than passing it', () => {
    const result = run(
      schema({ code: { type: 'string' } }, ['code']),
      { code: 'ABC' } as never,
      () => ({ fixed: true }),
      {
        build: (i) => {
          if (i.code !== 'ABC') throw new Error('only ABC builds');
        },
      },
    );
    expect(result.blocked?.code).toBe('CLASS_FIELDS_VARY');
    expect(result.blocked?.message).toContain('could not be checked');
  });

  it('passes constants, and leaves the inputs of the class key alone', () => {
    const inputs = schema({ event: { type: 'string' }, note: { type: 'string' } });
    expect(
      run(inputs, { event: 'gala', note: 'hi' } as never, () => ({ fixed: true })).blocked,
    ).toBeUndefined();
    const keyed = run(inputs, { event: 'gala', note: 'hi' } as never, (i) => ({ event: i.event }), {
      classKey: '{{event}}',
    });
    expect(keyed.blocked).toBeUndefined();
  });

  it('reads a bare reference in the class key, as the runtime does', () => {
    const inputs = schema({ event: { type: 'string' } });
    const sample = { event: 'gala' } as never;
    const keyed = run(inputs, sample, (i) => ({ event: i.event }), { classKey: '{{event}}' });
    expect(keyed.blocked).toBeUndefined();
  });

  it('tries well-formed values when the first alternates do not build', () => {
    const inputs = schema({ website: { type: 'string', format: 'uri' } });
    const build = (input: Record<string, unknown>) => {
      if (input.website !== undefined && !String(input.website).startsWith('https://'))
        throw new Error('bad');
    };
    const fixed = run(inputs, {} as never, () => ({ fixed: true }), { build });
    expect(fixed.blocked).toBeUndefined();
    const moves = run(inputs, {} as never, (i) => ({ site: i.website }), { build });
    expect(moves.blocked?.code).toBe('CLASS_FIELDS_VARY');
  });

  it('blocks the inputs past the compile bound as unchecked, and stays safe', () => {
    const names = Array.from({ length: MAX_PROBE_COMPILES + 6 }, (_, i) => `f${i}`);
    const properties = Object.fromEntries(names.map((n) => [n, { type: 'string' }]));
    const sample = Object.fromEntries(names.map((n) => [n, 'v']));
    let compiles = 0;
    const result = run(schema(properties), sample as never, () => {
      compiles += 1;
      return { fixed: true };
    });
    // One compile for the base view, then no more than the bound.
    expect(compiles).toBeLessThanOrEqual(MAX_PROBE_COMPILES + 1);
    expect(result.blocked?.code).toBe('CLASS_FIELDS_VARY');
    expect(result.blocked?.message).toContain('could not be checked');
  });
});

describe('the class field rule, adversarial templates', () => {
  const sch = (properties: object, required: string[] = []) => ({
    type: 'object',
    properties,
    required,
  });
  const exec = (
    inputs: object,
    sample: object,
    classOf: (input: Record<string, unknown>) => unknown,
    options: {
      classKey?: string;
      lookups?: Record<string, unknown>;
      literals?: Record<string, never[]>;
      build?: (input: Record<string, unknown>) => void;
    } = {},
  ) => {
    const viewFor = (input: Record<string, unknown>) => {
      options.build?.(input);
      return { input } as never;
    };
    const compiler = {
      target: 'google',
      revision: 1,
      compile: (view: { input: Record<string, unknown> }) => ({
        type: 'event',
        items: [],
        classBody: classOf(view.input),
        objectBody: {},
      }),
    } as never;
    const probes = classProbes(inputs, sample as never, options.classKey, viewFor, {
      ...(options.lookups ? { lookups: options.lookups } : {}),
      ...(options.literals ? { literals: options.literals } : {}),
    });
    return withClassRule(compiler, probes).compile(viewFor(sample as never), {
      now: new Date(),
      omit: [],
    });
  };

  it('never reuses the sample value as the probe (time zone, e-mail)', () => {
    for (const [name, value] of [
      ['tz', 'Europe/Paris'],
      ['mail', 'a@example.test'],
    ] as const) {
      const result = exec(
        sch({ [name]: { type: 'string' } }, [name]),
        { [name]: value },
        (i) => ({ shown: i[name] }),
        {
          build: (i) => {
            if (i[name] !== value) throw new Error('only the sample is valid');
          },
        },
      );
      expect(result.blocked?.code).toBe('CLASS_FIELDS_VARY');
    }
  });

  it('moves a date a day in its own offset, so a day-only class body is caught', () => {
    const result = exec(
      sch({ startsAt: { type: 'string', format: 'date-time' } }, ['startsAt']),
      { startsAt: '2030-01-01T18:00:00-05:00' },
      (i) => ({ day: String(i.startsAt).slice(0, 10) }),
      {
        build: (i) => {
          if (!/-05:00$/.test(String(i.startsAt))) throw new Error('needs the offset');
        },
      },
    );
    expect(result.blocked?.message).toContain('depend on pass data (startsAt)');
  });

  it('does not exempt an input read through a lookup, unknown or many-to-one', () => {
    const tiers = sch({ tier: { type: 'string', enum: ['a', 'b', 'c'] } }, ['tier']);
    const moves = (i: Record<string, unknown>) => ({ tier: i.tier });
    for (const lookups of [{ tiers: {} }, { tiers: { a: 'p', b: 'p', c: 'q' } }])
      expect(
        exec(tiers, { tier: 'a' }, moves, { classKey: '{{lookups.tiers[tier]}}', lookups }).blocked
          ?.code,
      ).toBe('CLASS_FIELDS_VARY');
  });

  it('does not exempt a whole object for a key that reads one field or the object', () => {
    const venue = sch({ venue: { type: 'object' } }, ['venue']);
    const sample = { venue: { name: 'N', address: 'A' } };
    const address = (i: Record<string, unknown>) => ({
      address: (i.venue as { address?: string } | undefined)?.address,
    });
    for (const classKey of ['{{venue.name}}', '{{venue}}'])
      expect(exec(venue, sample, address, { classKey }).blocked?.code).toBe('CLASS_FIELDS_VARY');
  });

  it('tries a second partner value for a paired input', () => {
    const result = exec(
      sch({ a: { type: 'string' }, b: { type: 'string', enum: ['bad', 'ok'] } }),
      {},
      (i) => ({ a: i.a }),
      {
        build: (i) => {
          if ((i.a === undefined) !== (i.b === undefined)) throw new Error('a pair');
          if (i.b === 'bad') throw new Error('bad partner');
        },
      },
    );
    expect(result.blocked?.message).toContain('depend on pass data (a)');
  });

  it('counts an input with no value to try as unchecked', () => {
    const result = exec(
      sch({ mode: { type: 'string', enum: ['only'] } }, ['mode']),
      { mode: 'only' },
      () => ({ fixed: true }),
      {
        build: (i) => {
          if (i.mode !== 'only') throw new Error('only one value');
        },
      },
    );
    expect(result.blocked?.message).toContain('could not be checked against mode');
  });

  it('tries the literals the template branches on', () => {
    const inputs = sch({ kind: { type: 'string' } }, ['kind']);
    const classOf = (i: Record<string, unknown>) => ({ premium: i.kind === 'premium' });
    expect(exec(inputs, { kind: 'a' }, classOf).blocked).toBeUndefined();
    expect(
      exec(inputs, { kind: 'a' }, classOf, { literals: { kind: ['premium'] as never[] } }).blocked
        ?.code,
    ).toBe('CLASS_FIELDS_VARY');
  });

  it('collects eq and in literals from the manifest', () => {
    expect(
      conditionLiterals({
        behaviors: [
          {
            when: {
              all: [
                { input: 'kind', eq: 'premium' },
                { input: 'k', in: [1, 2] },
              ],
            },
          },
        ],
      }),
    ).toEqual({ kind: ['premium'], k: [1, 2] });
  });

  it('never exempts an input the key reads only through a lookup', () => {
    const inputs = sch({ tier: { type: 'string' } }, ['tier']);
    const result = exec(inputs, { tier: 'gold' }, (i) => ({ tier: i.tier }), {
      classKey: '{{lookups.tiers[tier]}}',
      lookups: { tiers: { gold: 'Gold' } },
    });
    expect(result.blocked?.message).toContain('depend on pass data (tier)');
  });

  it('does not count a key that falls to the default class as a move', () => {
    const inputs = sch({ a: { type: 'string' } });
    const result = exec(inputs, { a: 'x' }, (i) => ({ a: i.a }), {
      classKey: '{{a}}',
      literals: { a: ['  '] as never[] },
    });
    expect(result.blocked?.message).toContain('depend on pass data (a)');
  });

  it('does not let a pair stand in for an input it did not change', () => {
    const result = exec(
      sch({ x: { type: ['string', 'null'] }, y: { type: 'string' } }),
      {},
      (i) => ({ x: i.x }),
    );
    expect(result.blocked?.message).toContain('could not be checked against x');
  });
});
