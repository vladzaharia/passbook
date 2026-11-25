import { ExprError, evaluate } from '../../../passkit/template/expr.ts';
import type { Json, Personalization } from '../../../passkit/types.ts';
import type {
  CompileResult,
  WalletCompiler,
  WalletPassView,
} from '../../../passkit/wallets/types.ts';
import { canonicalJson } from '../templates/package/hash.ts';

/**
 * Class-level fields (event name, venue, date, program, logo) belong to every pass of a Google class, so
 * they may depend only on template constants and on the inputs `google.classKey` reads. Anything else makes
 * two passes of one class disagree, and a class holds one answer. The review proves it input by input: each
 * input of the schema is changed alone, to a value of its own type, and the class body must not move.
 * An input is exempt only where changing it changes the evaluated class key, for every value tried.
 * An input that cannot be changed and still build is not a pass: it is reported as unchecked and blocks.
 */
export const CLASS_RULE_REVISION = 4;

/** Compiles the review spends on the probes of one candidate; an input past it is unchecked, which blocks. */
export const MAX_PROBE_COMPILES = 64;

const DAY = 86_400_000;
const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?=$|T)/;

type Schema = Record<string, unknown>;
const isObject = (value: unknown): value is Schema =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Inputs the key reads as a whole value (`{{name}}`, `{{name|url}}`), never as a lookup key or a field of one. */
function directInputs(classKey: string): Set<string> {
  const names = new Set<string>();
  for (const m of classKey.matchAll(/\{\{\s*([\w-]+)\s*(?:\|\s*\w+\s*)?\}\}/g))
    if (m[1] !== undefined) names.add(m[1]);
  return names;
}

/** A date or date-time one day later, in the same shape (offset, `Z`, date only); anything else is unchanged. */
function nextDay(value: string): string | undefined {
  const m = DATE_PREFIX.exec(value);
  if (!m) return undefined;
  const moved = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + DAY);
  return moved.toISOString().slice(0, 10) + value.slice(10);
}

/** Every leaf changed to another value of its type; dates move a day. */
function deepVary(value: Json): Json {
  if (typeof value === 'string') return nextDay(value) ?? `${value} x`;
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'boolean') return !value;
  if (Array.isArray(value)) return value.map(deepVary);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepVary(v as Json)]));
  return value;
}

/** Well-formed strings of the common shapes, tried when the schema's own alternates do not build. */
const STRING_POOL: Json[] = [
  'https://example.test/alt',
  'Z',
  'ZZ',
  'ZZZ',
  'Europe/Paris',
  'a@example.test',
  '+14155550199',
];
const POOL_DATE = '2030-01-01T09:00:00-05:00';

/** The pool for one input: never the value it already has, and a date one day from its own. */
function poolFor(current: Json | undefined): Json[] {
  const date = (typeof current === 'string' && nextDay(current)) || POOL_DATE;
  return [...STRING_POOL, date].filter((v) => canonicalJson(v) !== canonicalJson(current));
}

/** A value that is not the current one: of the schema's type, from its enum, or present where it was absent. */
function alternatesOf(schema: Schema, current: Json | undefined): Json[] {
  const out: Json[] = [];
  const type = schema.type;
  const choices = Array.isArray(schema.enum) ? (schema.enum as Json[]) : [];
  if (choices.length)
    out.push(...choices.filter((c) => canonicalJson(c) !== canonicalJson(current)));
  else if (type === 'boolean') out.push(current !== true);
  else if (type === 'integer' || type === 'number')
    out.push(typeof current === 'number' ? current + 1 : 1);
  else if (type === 'array') out.push(current === undefined ? [] : deepVary(current), []);
  else if (type === 'object') out.push(current === undefined ? {} : deepVary(current));
  else if (type === 'string' || type === undefined) {
    if (typeof current === 'string') {
      out.push(deepVary(current));
      if (schema.format === 'uri' || schema.format === 'url') out.push('https://example.test/alt');
    } else out.push(schema.format === 'date' ? '2030-01-01' : 'x');
  }
  return out.filter((v) => canonicalJson(v) !== canonicalJson(current));
}

/** The literals the template's own conditions compare each input with (`eq`, `in`): values it branches on. */
export function conditionLiterals(manifest: unknown): Record<string, Json[]> {
  const found: Record<string, Json[]> = {};
  const walk = (node: unknown, depth: number): void => {
    if (depth > 24 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const entry = node as Schema;
    if (typeof entry.input === 'string') {
      const list = found[entry.input] ?? [];
      found[entry.input] = list;
      if (entry.eq !== undefined) list.push(entry.eq as Json);
      if (Array.isArray(entry.in)) list.push(...(entry.in as Json[]));
    }
    for (const value of Object.values(entry)) walk(value, depth + 1);
  };
  walk(manifest, 0);
  return found;
}

export interface ClassProbe {
  input: string;
  views: (() => WalletPassView)[];
  /** Tried, every one that builds, only when no view of `views` builds: pool strings, then paired inputs. */
  fallback?: () => (() => WalletPassView)[];
}

export interface ClassProbeOptions {
  /** The class key as the runtime evaluates it for one pass's input. Default: `evaluate` with `lookups`. */
  keyOf?: (input: Personalization) => unknown;
  lookups?: Record<string, unknown>;
  /** `conditionLiterals` of the manifest: values to try in addition to the schema's own. */
  literals?: Record<string, Json[]>;
}

/** One probe per input of the schema that `google.classKey` does not provably read; absent is one more value. */
export function classProbes(
  inputs: unknown,
  sample: Personalization,
  classKey: unknown,
  viewFor: (input: Personalization) => WalletPassView,
  options: ClassProbeOptions = {},
): ClassProbe[] {
  const properties = isObject(inputs) && isObject(inputs.properties) ? inputs.properties : {};
  const names = new Set([...Object.keys(properties), ...Object.keys(sample)]);
  const required = isObject(inputs) && Array.isArray(inputs.required) ? inputs.required : [];
  const schemaOf = (name: string): Schema => (isObject(properties[name]) ? properties[name] : {});
  const isStringInput = (name: string) => {
    const type = schemaOf(name).type;
    return type === 'string' || type === undefined;
  };
  const valuesOf = (name: string): (Json | undefined)[] => {
    const current = sample[name];
    const values: (Json | undefined)[] = alternatesOf(schemaOf(name), current);
    for (const literal of options.literals?.[name] ?? [])
      if (!values.some((v) => canonicalJson(v) === canonicalJson(literal))) values.push(literal);
    if (current !== undefined && !required.includes(name)) values.push(undefined);
    return values.filter((v) => v === undefined || canonicalJson(v) !== canonicalJson(current));
  };
  const viewWith = (changes: [string, Json | undefined][]) => () => {
    const input = { ...sample };
    for (const [key, value] of changes) {
      if (value === undefined) delete input[key];
      else input[key] = value;
    }
    return viewFor(input);
  };

  const keyOf =
    typeof classKey === 'string'
      ? (options.keyOf ??
        ((input: Personalization) =>
          evaluate(classKey, { input, lookups: (options.lookups ?? {}) as never })))
      : undefined;
  const keyText = (input: Personalization): string | undefined => {
    try {
      const value = keyOf?.(input);
      return typeof value === 'object' && value !== null
        ? canonicalJson(value)
        : String(value ?? '').trim();
    } catch (error) {
      if (error instanceof ExprError) return undefined;
      throw error;
    }
  };
  const baseKey = keyText(sample);
  const reads = typeof classKey === 'string' ? directInputs(classKey) : new Set<string>();
  /** The key moves with this input for every value tried, and the input is a scalar (not one field of an object). */
  const keyed = (name: string): boolean => {
    if (!reads.has(name) || baseKey === undefined) return false;
    const type = schemaOf(name).type;
    if (type === 'object' || type === 'array' || isObject(sample[name])) return false;
    const values = valuesOf(name);
    return (
      values.length > 0 &&
      values.every((value) => {
        const input = { ...sample };
        if (value === undefined) delete input[name];
        else input[name] = value;
        const moved = keyText(input);
        // A present value that sends the key to '' (the default class) is no move; an absent input may.
        return moved !== undefined && (value === undefined || moved !== '') && moved !== baseKey;
      })
    );
  };

  const open = [...names].filter((name) => !keyed(name));
  return open.map((name) => {
    const own = valuesOf(name);
    return {
      input: name,
      views: own.map((value) => viewWith([[name, value]])),
      fallback: () => [
        ...(isStringInput(name)
          ? poolFor(sample[name]).map((value) => viewWith([[name, value]]))
          : []),
        ...open
          .filter(
            (other) =>
              other !== name &&
              sample[other] === undefined &&
              own.length > 0 &&
              canonicalJson(own[0]) !== canonicalJson(sample[name]),
          )
          .flatMap((other) =>
            valuesOf(other)
              .slice(0, 2)
              .map((second) =>
                viewWith([
                  [name, own[0]],
                  [other, second],
                ]),
              ),
          ),
      ],
    };
  });
}

function blocked(result: CompileResult, message: string): CompileResult {
  return { ...result, blocked: { code: 'CLASS_FIELDS_VARY', message } };
}

/** The compiler as the review sees it: blocked when the class body moves with pass data, or cannot be shown not to. */
export function withClassRule(
  compiler: WalletCompiler,
  probes: readonly ClassProbe[],
): WalletCompiler {
  return {
    ...compiler,
    compile(view, options): CompileResult {
      const result = compiler.compile(view, options);
      if (result.blocked || result.classBody === undefined) return result;
      const base = canonicalJson(result.classBody);
      const varies: string[] = [];
      const unchecked: string[] = [];
      let compiles = 0;
      /** Compiles every view that builds, until the class body moves or the budget ends; false: cut short. */
      const run = (makers: (() => WalletPassView)[]) => {
        let built = 0;
        for (const make of makers) {
          if (compiles >= MAX_PROBE_COMPILES) return { built, moved: false, cut: true };
          let other: WalletPassView;
          try {
            other = make();
          } catch {
            continue;
          }
          built += 1;
          compiles += 1;
          if (canonicalJson(compiler.compile(other, options).classBody) !== base)
            return { built, moved: true, cut: false };
        }
        return { built, moved: false, cut: false };
      };
      for (const probe of probes) {
        let tried = run(probe.views);
        if (!tried.moved && !tried.cut && tried.built === 0) tried = run(probe.fallback?.() ?? []);
        if (tried.moved) varies.push(probe.input);
        else if (tried.cut || tried.built === 0) unchecked.push(probe.input);
      }
      if (varies.length)
        return blocked(
          result,
          `Google class fields depend on pass data (${varies.join(', ')}). Use only template values or the inputs of google.classKey.`,
        );
      if (unchecked.length)
        return blocked(
          result,
          `Google class fields could not be checked against ${unchecked.join(', ')}. Give each input values that build, or read it in google.classKey.`,
        );
      return result;
    },
  };
}
