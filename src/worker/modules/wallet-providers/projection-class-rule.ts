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
 * An input that cannot be changed and still build is not a pass: it is reported as unchecked and blocks.
 */
export const CLASS_RULE_REVISION = 1;

const DAY = 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const CLASS_KEY_INPUT = /\binput(?:\.([A-Za-z0-9_]+)|\[\s*['"]([^'"]+)['"]\s*\])/g;

type Schema = Record<string, unknown>;
const isObject = (value: unknown): value is Schema =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Every leaf changed to another value of its type; dates move a day. */
function deepVary(value: Json): Json {
  if (typeof value === 'string')
    return ISO.test(value)
      ? new Date(Date.parse(value) + DAY)
          .toISOString()
          .slice(0, value.length === 10 ? 10 : undefined)
      : `${value} x`;
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'boolean') return !value;
  if (Array.isArray(value)) return value.map(deepVary);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepVary(v as Json)]));
  return value;
}

/** A value that is not the current one: of the schema's type, from its enum, or present where it was absent. */
function alternatesOf(schema: Schema, current: Json | undefined): Json[] {
  const out: Json[] = [];
  const type = schema.type;
  const choices = Array.isArray(schema.enum) ? (schema.enum as Json[]) : [];
  if (choices.length)
    out.push(...choices.filter((c) => canonicalJson(c) !== canonicalJson(current)));
  else if (type === 'boolean') out.push(current === true ? false : true);
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

export interface ClassProbe {
  input: string;
  views: (() => WalletPassView)[];
}

/** One probe per input of the schema that `google.classKey` does not read; absent is one more value. */
export function classProbes(
  inputs: unknown,
  sample: Personalization,
  classKey: unknown,
  viewFor: (input: Personalization) => WalletPassView,
): ClassProbe[] {
  const properties = isObject(inputs) && isObject(inputs.properties) ? inputs.properties : {};
  const names = new Set([...Object.keys(properties), ...Object.keys(sample)]);
  const kept = new Set(
    typeof classKey === 'string'
      ? [...classKey.matchAll(CLASS_KEY_INPUT)].flatMap((m) => [m[1] ?? m[2] ?? ''])
      : [],
  );
  const required = isObject(inputs) && Array.isArray(inputs.required) ? inputs.required : [];
  return [...names]
    .filter((name) => !kept.has(name))
    .map((name) => {
      const schema = isObject(properties[name]) ? properties[name] : {};
      const current = sample[name];
      const values: (Json | undefined)[] = alternatesOf(schema, current);
      if (current !== undefined && !required.includes(name)) values.push(undefined);
      return {
        input: name,
        views: values.map((value) => () => {
          const input = { ...sample };
          if (value === undefined) delete input[name];
          else input[name] = value;
          return viewFor(input);
        }),
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
      for (const probe of probes) {
        let built = 0;
        for (const make of probe.views) {
          let other: WalletPassView;
          try {
            other = make();
          } catch {
            continue;
          }
          built += 1;
          if (canonicalJson(compiler.compile(other, options).classBody) !== base) {
            varies.push(probe.input);
            break;
          }
        }
        if (built === 0 && probe.views.length > 0) unchecked.push(probe.input);
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
