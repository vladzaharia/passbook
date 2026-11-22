// R2-M1: Google class fields may depend only on template values and the class key's inputs.
import { afterEach, describe, expect, it } from 'vitest';
import { googleCompiler } from '../../../passkit/wallets/google/compilers.ts';
import type { CompileResult } from '../../../passkit/wallets/types.ts';
import { getVersion } from '../templates/repo.ts';
import { classProbes, MAX_PROBE_COMPILES, withClassRule } from './projection-class-rule.ts';
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
    options: { classKey?: string; build?: (input: Record<string, unknown>) => void } = {},
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
    const ruled = withClassRule(compiler, classProbes(inputs, sample, options.classKey, viewFor));
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
      classKey: '{{input.event}}',
    });
    expect(keyed.blocked).toBeUndefined();
    const bracket = run(
      inputs,
      { event: 'gala', note: 'hi' } as never,
      (i) => ({ event: i.event }),
      {
        classKey: "{{input['event']}}",
      },
    );
    expect(bracket.blocked).toBeUndefined();
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
