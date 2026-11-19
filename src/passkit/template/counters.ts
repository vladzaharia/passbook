import { GOAL_MAX, GOAL_MIN } from '../stamps/layout.ts';
import { counterScope, isGoal } from '../stamps/rules.ts';
import type {
  CounterManifest,
  IssueParams,
  Json,
  PassJson,
  Personalization,
  StampsManifest,
  TemplateManifest,
  ValidationIssue,
} from '../types.ts';
import type { PassScope } from './expr.ts';
import { STRIP_LOCALIZED, STRIP_STYLES, stampScopeFor } from './stamps.ts';

export const COUNTERS_MAX = 4;
export const COUNTER_SIZE_MAX = 1000;
/** The leaves of `pass.counters.<id>`. */
export const COUNTER_VALUES = ['left', 'used', 'size', 'none', 'text'] as const;
const ID = /^[a-z][a-z0-9_]{0,31}$/;
const INPUT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ART = /^stamps\/[\w-]+\.png$/;

const isRecord = (v: unknown): v is Record<string, Json> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const sizeInput = (c: { size?: unknown }): string | undefined =>
  isRecord(c.size) && typeof c.size.input === 'string' ? c.size.input : undefined;

/** The counters well-formed enough to compute with, by id. */
function usable(manifest: Pick<TemplateManifest, 'counters'>): [string, CounterManifest][] {
  const block: unknown = manifest.counters;
  if (!isRecord(block)) return [];
  return (Object.entries(block) as [string, unknown][]).filter(
    (e): e is [string, CounterManifest] => {
      const c = e[1];
      return (
        isRecord(c) &&
        typeof c.input === 'string' &&
        ((typeof c.size === 'number' && Number.isInteger(c.size) && c.size >= 1) ||
          sizeInput(c) !== undefined)
      );
    },
  );
}

/** A missing or non-numeric input is 0, after the declared default: one meaning everywhere. */
const read = (input: Personalization, name: string): number => {
  const v = input[name];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};
const sizeOf = (c: CounterManifest, input: Personalization): number =>
  typeof c.size === 'number' ? c.size : Math.max(0, Math.floor(read(input, c.size.input)));

/** The computed `pass.stamps.*` and `pass.counters.*` of a pass; empty for a plain template. */
export function derivedPassScope(manifest: TemplateManifest, input: Personalization): PassScope {
  const out: PassScope = {};
  const stamps = stampScopeFor(manifest, input);
  if (stamps) out.stamps = stamps;
  const entries = usable(manifest);
  if (entries.length > 0) {
    out.counters = {};
    for (const [id, c] of entries)
      out.counters[id] = counterScope(read(input, c.input), sizeOf(c, input));
  }
  return out;
}

/**
 * What draws the strip: the stamps block, or the one counter with art and a fixed size. A counter
 * fills one image for each one left, so the compositor draws `size` cells with `left` filled.
 */
export function stripBlock(
  manifest: Pick<TemplateManifest, 'stamps' | 'counters'>,
): StampsManifest | undefined {
  if (manifest.stamps) return manifest.stamps;
  const found = usable(manifest).find(([, c]) => c.art !== undefined && typeof c.size === 'number');
  const c = found?.[1];
  if (!c?.art || typeof c.size !== 'number') return undefined;
  return {
    input: c.input,
    goal: c.size,
    art: c.art,
    ...(c.tilt === false ? { tilt: false } : {}),
  };
}

/** The count the strip draws for a pass (0 to goal), or undefined when nothing draws a strip. */
export function stripCount(manifest: TemplateManifest, input: Personalization): number | undefined {
  if (manifest.stamps) return stampScopeFor(manifest, input)?.card;
  const block = stripBlock(manifest);
  if (!block) return undefined;
  return Math.min(block.goal, counterScope(read(input, block.input), block.goal).left);
}

/**
 * Scan `take` actions give a counter's row its size, by input. A per-pass size gives its input's
 * default (a row's own `goal` expression is what draws it).
 */
export function counterSizes(
  manifest: Pick<TemplateManifest, 'counters'> & { inputs?: TemplateManifest['inputs'] },
): Record<string, number> {
  const props = isRecord(manifest.inputs?.properties) ? manifest.inputs.properties : {};
  const out: Record<string, number> = {};
  for (const [, c] of usable(manifest)) {
    const dflt = (props[sizeInput(c) ?? ''] as Record<string, unknown> | undefined)?.default;
    out[c.input] = typeof c.size === 'number' ? c.size : isCount(dflt) && dflt >= 1 ? dflt : 1;
  }
  return out;
}

/** The unknown `pass.counters` references in an expression: the id and leaf must exist. */
export function unknownCounterRefs(
  expr: string,
  manifest: Pick<TemplateManifest, 'counters'>,
): string[] {
  const ids = new Set(Object.keys(isRecord(manifest.counters) ? manifest.counters : {}));
  return [...expr.matchAll(/\bpass\.counters(?:\.(\w+))?(?:\.(\w+))?/g)]
    .filter(
      (m) => !(m[1] && ids.has(m[1]) && (COUNTER_VALUES as readonly string[]).includes(m[2] ?? '')),
    )
    .map((m) => m[0].replace(/^pass\./, ''));
}

/** Manifest-level checks for the `counters` block. Art pixels are checked when strips are drawn. */
export function countersIssues(
  manifest: TemplateManifest,
  passJson?: PassJson,
  assetNames: readonly string[] = [],
): ValidationIssue[] {
  const block = manifest.counters as unknown;
  if (block === undefined) return [];
  const issues: ValidationIssue[] = [];
  const add =
    (severity: 'error' | 'warning') =>
    (code: string, message: string, path = 'counters', params?: IssueParams) =>
      issues.push({ severity, code, message, path, ...(params ? { params } : {}) });
  const error = add('error');
  const warn = add('warning');
  if (!isRecord(block)) {
    error('COUNTERS_SHAPE', 'counters must be an object keyed by counter id.');
    return issues;
  }
  const entries = Object.entries(block);
  if (entries.length > COUNTERS_MAX) error('COUNTERS_SHAPE', `At most ${COUNTERS_MAX} counters.`);
  const properties = isRecord(manifest.inputs?.properties) ? manifest.inputs.properties : {};
  const integerInput = (name: unknown) => {
    const schema = typeof name === 'string' ? properties[name] : undefined;
    return isRecord(schema) && schema.type === 'integer' && (schema.minimum ?? 0) === 0
      ? schema
      : undefined;
  };
  const inputs = new Set<string>();
  const withArt: string[] = [];
  for (const [id, c] of entries) {
    const at = `counters/${id}`;
    if (!ID.test(id))
      error('COUNTER_ID', 'A counter id is lower-case letters, digits and _, up to 32.', at);
    if (!isRecord(c)) {
      error('COUNTERS_SHAPE', 'A counter must be an object.', at);
      continue;
    }
    const { size } = c;
    const fixed = typeof size === 'number';
    if (fixed) {
      if (!Number.isInteger(size) || size < 1 || size > COUNTER_SIZE_MAX)
        error(
          'COUNTER_SIZE',
          `size must be a whole number from 1 to ${COUNTER_SIZE_MAX}.`,
          `${at}/size`,
        );
    } else if (!(isRecord(size) && typeof size.input === 'string' && INPUT.test(size.input)))
      error('COUNTER_SIZE', 'size is a number or { "input": name }.', `${at}/size`);
    else if (
      !isRecord(properties[size.input]) ||
      (properties[size.input] as Record<string, unknown>).type !== 'integer'
    )
      error('COUNTER_SIZE', 'The size input must be an integer input.', `${at}/size`);

    const name = c.input;
    const schema = integerInput(name);
    if (typeof name !== 'string' || !INPUT.test(name))
      error(
        'COUNTER_INPUT',
        'input must be a plain input name (letters, digits, _).',
        `${at}/input`,
      );
    else if (inputs.has(name) || name === manifest.stamps?.input || name === sizeInput(c))
      error('COUNTER_INPUT', `Input "${name}" already counts something else.`, `${at}/input`);
    else if (!schema)
      error('COUNTER_INPUT', 'input must be an integer input starting at 0.', `${at}/input`);
    else if (fixed && typeof schema.maximum === 'number' && schema.maximum < size)
      error(
        'COUNTER_INPUT',
        `The input stops at ${schema.maximum}, under the size ${size}.`,
        `${at}/input`,
      );
    if (typeof name === 'string') inputs.add(name);

    if (c.art !== undefined) {
      withArt.push(id);
      const art = c.art;
      if (
        !isRecord(art) ||
        typeof art.filled !== 'string' ||
        typeof art.empty !== 'string' ||
        !ART.test(art.filled) ||
        !ART.test(art.empty)
      )
        error(
          'COUNTER_ART',
          'Add stamps/filled.png and stamps/empty.png, or similar.',
          `${at}/art`,
        );
      if (!fixed || !isGoal(size))
        error(
          'COUNTER_STRIP_SIZE',
          `A strip needs a fixed size of ${GOAL_MIN} to ${GOAL_MAX}. Remove art or change size.`,
          `${at}/size`,
        );
    }
  }
  if (withArt.length > 1)
    error('COUNTER_STRIP', 'One strip, one counter: only one counter may have art.');
  if (withArt.length > 0 && manifest.stamps !== undefined)
    error('COUNTER_STRIP', 'Stamps already draw the strip. Remove the counter art.');
  if (withArt.length > 0) {
    if (assetNames.some((n) => STRIP_LOCALIZED.test(n)))
      error('COUNTER_LOCALIZED', 'A counter draws one strip. Remove localized strips.');
    if (passJson && !STRIP_STYLES.some((s) => isRecord(passJson[s])))
      error(
        'COUNTER_STYLE',
        'A counter strip needs a style with a strip: store card, coupon or event ticket.',
      );
  }

  const byInput = new Map(usable(manifest).map(([, c]) => [c.input, c]));
  const actions: unknown[] = Array.isArray(manifest.scan?.actions) ? manifest.scan.actions : [];
  const used = new Set<string>();
  actions.forEach((a, i) => {
    if (!isRecord(a) || typeof a.input !== 'string' || !byInput.has(a.input)) return;
    if (a.kind === 'take') used.add(a.input);
    // A set without a value takes the staff's, checked against the input's schema when applied.
    const max = (properties[a.input] as Record<string, unknown> | undefined)?.maximum;
    if (
      a.kind === 'set' &&
      a.value !== undefined &&
      !(isCount(a.value) && (typeof max !== 'number' || a.value <= max))
    )
      error(
        'SCAN_COUNTER_VALUE',
        'Set a whole number from 0 up to the input maximum.',
        `scan.actions.${i}.value`,
      );
  });
  for (const input of byInput.keys())
    if (!used.has(input))
      warn('COUNTER_NO_USE', `If a scanner uses "${input}", add a take action.`, 'scan.actions', {
        name: input,
      });
  return issues;
}
