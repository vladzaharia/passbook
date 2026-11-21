import { RE2JS } from 're2js';

/**
 * Template input `pattern`s run on RE2 (linear time), never on the engine's backtracking RegExp.
 * A pattern RE2 cannot express (backreferences, lookaround) is advisory on stored templates.
 */
export const PATTERN_MAX_LENGTH = 200;
/** Longer text than this is never handed to a pattern; it counts as not matching. */
const MATCH_INPUT_MAX = 10_000;
const CACHE_MAX = 256;

/** Matches no string, in any engine: what a failed pattern becomes for the JSON Schema validator. */
const NEVER = '[^\\s\\S]';

const cache = new Map<string, RE2JS | null>();
const reported = new Set<string>();
let reporter: (pattern: string) => void = () => undefined;

/** The worker's hook: called once per unsupported pattern per isolate. */
export function onUnsupportedPattern(fn: (pattern: string) => void): void {
  reporter = fn;
}

function compiled(pattern: string): RE2JS | null {
  const hit = cache.get(pattern);
  if (hit !== undefined) return hit;
  let re: RE2JS | null = null;
  try {
    re = RE2JS.compile(pattern);
  } catch {
    // Unsupported syntax is an answer, not a failure: the caller treats the pattern as advisory.
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(pattern, re);
  return re;
}

/** Whether RE2 can run the pattern; false for backreferences, lookaround and bad syntax. */
export const isLinearPattern = (pattern: string): boolean => compiled(pattern) !== null;

/** Unanchored search, as JSON Schema `pattern` is. An unsupported pattern passes and is reported once. */
export function patternMatches(pattern: string, value: string): boolean {
  const re = compiled(pattern);
  if (!re) {
    if (!reported.has(pattern) && reported.size < CACHE_MAX) {
      reported.add(pattern);
      reporter(pattern);
    }
    return true;
  }
  return value.length <= MATCH_INPUT_MAX && re.matcher(value).find();
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A copy of the inputs schema with every `pattern` already decided for `values` (the instances the
 * schema applies to), so the JSON Schema validator never compiles a backtracking regex. A value
 * over its `maxLength` skips the pattern: the length error already stands.
 */
export function decidePatterns(schema: unknown, values: unknown[]): unknown {
  if (!isRec(schema)) return schema;
  const out: Rec = { ...schema };
  if (typeof schema.pattern === 'string') {
    const pattern = schema.pattern;
    const max = typeof schema.maxLength === 'number' ? schema.maxLength : Number.POSITIVE_INFINITY;
    const ok = values.every(
      (v) =>
        typeof v !== 'string' ||
        (v.length > max && [...v].length > max) ||
        patternMatches(pattern, v),
    );
    if (ok) delete out.pattern;
    else out.pattern = NEVER;
  }
  const records = values.filter(isRec);
  if (isRec(schema.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => [
        key,
        decidePatterns(
          child,
          records.map((r) => r[key]),
        ),
      ]),
    );
  }
  if (isRec(schema.items))
    out.items = decidePatterns(schema.items, values.filter(Array.isArray).flat());
  if (isRec(schema.additionalProperties)) {
    const named = isRec(schema.properties) ? schema.properties : {};
    out.additionalProperties = decidePatterns(
      schema.additionalProperties,
      records.flatMap((r) =>
        Object.entries(r)
          .filter(([k]) => !(k in named))
          .map(([, v]) => v),
      ),
    );
  }
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const list = schema[key];
    if (Array.isArray(list)) out[key] = list.map((child) => decidePatterns(child, values));
  }
  if (isRec(schema.not)) out.not = decidePatterns(schema.not, values);
  return out;
}

/** The inputs schema ready for the validator, for one instance. */
export const schemaFor = (schema: unknown, value: unknown): never =>
  decidePatterns(schema, [value]) as never;
