import { GOAL_MAX, GOAL_MIN } from '../stamps/layout.ts';
import { counterScope, isGoal } from '../stamps/rules.ts';
import type {
  CounterManifest,
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
const ID = /^[a-z][a-z0-9_]{0,31}$/;
const INPUT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ART = /^stamps\/[\w-]+\.png$/;

const isRecord = (v: unknown): v is Record<string, Json> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The counters that are well-formed enough to compute with, by id. */
function usable(manifest: Pick<TemplateManifest, 'counters'>): [string, CounterManifest][] {
  const block: unknown = manifest.counters;
  if (!isRecord(block)) return [];
  return (Object.entries(block) as [string, unknown][]).filter(
    (e): e is [string, CounterManifest] => {
      const c = e[1];
      return (
        isRecord(c) &&
        typeof c.input === 'string' &&
        typeof c.size === 'number' &&
        Number.isInteger(c.size) &&
        c.size >= 1
      );
    },
  );
}

/** The computed `pass.stamps.*` and `pass.counters.*` of a pass; empty for a plain template. */
export function derivedPassScope(manifest: TemplateManifest, input: Personalization): PassScope {
  const out: PassScope = {};
  const stamps = stampScopeFor(manifest, input);
  if (stamps) out.stamps = stamps;
  const entries = usable(manifest);
  if (entries.length > 0) {
    out.counters = {};
    for (const [id, c] of entries) {
      const raw = input[c.input];
      out.counters[id] = counterScope(typeof raw === 'number' ? raw : c.size, c.size);
    }
  }
  return out;
}

/**
 * What draws the strip: the stamps block, or the one counter with art. A counter fills one image
 * for each one left, so the compositor draws `size` cells with `left` filled.
 */
export function stripBlock(
  manifest: Pick<TemplateManifest, 'stamps' | 'counters'>,
): StampsManifest | undefined {
  if (manifest.stamps) return manifest.stamps;
  const [, c] = usable(manifest).find(([, c]) => c.art !== undefined) ?? [];
  if (!c?.art) return undefined;
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
  const raw = input[block.input];
  return counterScope(typeof raw === 'number' ? raw : block.goal, block.goal).left;
}

/** Scan `take` actions give a counter's row its size, by input. */
export function counterSizes(manifest: Pick<TemplateManifest, 'counters'>): Record<string, number> {
  return Object.fromEntries(usable(manifest).map(([, c]) => [c.input, c.size]));
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
    (code: string, message: string, path = 'counters') =>
      issues.push({ severity, code, message, path });
  const error = add('error');
  const warn = add('warning');
  if (!isRecord(block)) {
    error('COUNTERS_SHAPE', 'counters must be an object keyed by counter id.');
    return issues;
  }
  const entries = Object.entries(block);
  if (entries.length > COUNTERS_MAX) error('COUNTERS_SHAPE', `At most ${COUNTERS_MAX} counters.`);
  const properties = isRecord(manifest.inputs?.properties) ? manifest.inputs.properties : {};
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
    const sizeOk = typeof size === 'number' && Number.isInteger(size) && size >= 1;
    if (!sizeOk || (size as number) > COUNTER_SIZE_MAX)
      error(
        'COUNTER_SIZE',
        `size must be a whole number from 1 to ${COUNTER_SIZE_MAX}.`,
        `${at}/size`,
      );

    const name = c.input;
    const schema = typeof name === 'string' ? properties[name] : undefined;
    if (typeof name !== 'string' || !INPUT.test(name))
      error(
        'COUNTER_INPUT',
        'input must be a plain input name (letters, digits, _).',
        `${at}/input`,
      );
    else if (inputs.has(name) || name === manifest.stamps?.input)
      error('COUNTER_INPUT', `Input "${name}" already counts something else.`, `${at}/input`);
    else if (
      !isRecord(schema) ||
      schema.type !== 'integer' ||
      (schema.minimum ?? 0) !== 0 ||
      (sizeOk && schema.maximum !== size)
    )
      error(
        'COUNTER_INPUT',
        'input must be an integer input from 0 to size, with maximum equal to size.',
        `${at}/input`,
      );
    else if (sizeOk && schema.default !== size)
      warn(
        'COUNTER_DEFAULT',
        'A new pass should start full: set the input default to size.',
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
      if (sizeOk && !isGoal(size))
        error(
          'COUNTER_STRIP_SIZE',
          `A strip draws ${GOAL_MIN} to ${GOAL_MAX} images. Remove art or change size.`,
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

  const sizes = new Map(usable(manifest).map(([, c]) => [c.input, c.size]));
  const actions: unknown[] = Array.isArray(manifest.scan?.actions) ? manifest.scan.actions : [];
  const used = new Set<string>();
  actions.forEach((a, i) => {
    if (!isRecord(a) || typeof a.input !== 'string') return;
    const size = sizes.get(a.input);
    if (size === undefined) return;
    const path = `scan.actions.${i}`;
    if (a.kind === 'take') used.add(a.input);
    if (a.kind === 'take' || a.kind === 'add') {
      const amount = isRecord(a.amount) ? a.amount.max : a.amount;
      if (typeof amount === 'number' && amount > size)
        error(
          'SCAN_COUNTER_AMOUNT',
          `The counter holds ${size}: the amount cannot be more.`,
          `${path}.amount`,
        );
    }
    if (a.kind === 'set' && !(typeof a.value === 'number' && a.value >= 0 && a.value <= size))
      error('SCAN_COUNTER_VALUE', `Set a value from 0 to ${size}.`, `${path}.value`);
  });
  for (const [input] of sizes)
    if (!used.has(input))
      warn('COUNTER_NO_USE', `Nothing at the scanner takes from "${input}".`, 'scan.actions');
  return issues;
}
