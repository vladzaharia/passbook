import { GOAL_MAX, GOAL_MIN } from '../stamps/layout.ts';
import { isGoal, maxStamps, type StampScope, stampScope } from '../stamps/rules.ts';
import type {
  Binding,
  Condition,
  Json,
  PassJson,
  Personalization,
  TemplateManifest,
  ValidationIssue,
} from '../types.ts';
import { exprReferences } from './expr.ts';

const isRecord = (v: unknown): v is Record<string, Json> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `pass.stamps.*` for a card, or undefined when the template has no stamps block. */
export function stampScopeFor(
  manifest: TemplateManifest,
  input: Personalization,
): StampScope | undefined {
  const block = manifest.stamps;
  if (!block || !isGoal(block.goal)) return undefined;
  const raw = input[block.input];
  return stampScope(typeof raw === 'number' ? raw : 0, block.goal);
}

/** The expression scope's `pass` part for a stamp card; empty for any other template. */
export function stampPassScope(
  manifest: TemplateManifest,
  input: Personalization,
): { pass?: { stamps: StampScope } } {
  const stamps = stampScopeFor(manifest, input);
  return stamps ? { pass: { stamps } } : {};
}

const STRIP_STYLES = ['storeCard', 'coupon', 'eventTicket'] as const;
const STRIP_LOCALIZED = /^[\w-]+\.lproj\/strip(?:@[23]x)?\.png$/;

function readsStamps(binding: Binding, input: string): boolean {
  if (typeof binding.value !== 'string') return false;
  const refs = exprReferences(binding.value);
  return (
    refs.inputs.includes(input) || /\bpass\.stamps\.(?:card|left|extra|goal)\b/.test(binding.value)
  );
}

function mentionsReady(condition: Condition | undefined): boolean {
  if (!condition) return false;
  if ('all' in condition) return condition.all.some(mentionsReady);
  if ('any' in condition) return condition.any.some(mentionsReady);
  if ('not' in condition) return false;
  return condition.input === 'pass.stamps.ready';
}

/** The target field key of a binding, when it is a single field target. */
const fieldOf = (b: Binding): { key: string; prop: string } | null => {
  const to = b.to as unknown as Record<string, unknown>;
  return typeof to.field === 'string' ? { key: to.field, prop: String(to.prop ?? 'value') } : null;
};

/** Manifest-level checks for the `stamps` block. File and pixel checks live in the analyzer. */
export function stampsIssues(
  manifest: TemplateManifest,
  passJson?: PassJson,
  assetNames: readonly string[] = [],
): ValidationIssue[] {
  const block = manifest.stamps as unknown;
  if (block === undefined) return [];
  const issues: ValidationIssue[] = [];
  const add =
    (severity: 'error' | 'warning') =>
    (code: string, message: string, path = 'stamps') =>
      issues.push({ severity, code, message, path });
  const error = add('error');
  const warn = add('warning');
  if (!isRecord(block)) {
    error('STAMPS_GOAL', 'stamps must be an object.');
    return issues;
  }
  const goal = block.goal;
  if (!isGoal(goal))
    error(
      'STAMPS_GOAL',
      `Goal must be a whole number from ${GOAL_MIN} to ${GOAL_MAX}.`,
      'stamps/goal',
    );

  const properties = isRecord(manifest.inputs?.properties) ? manifest.inputs.properties : {};
  const input = typeof block.input === 'string' ? properties[block.input] : undefined;
  if (!isRecord(input) || input.type !== 'integer' || (input.minimum ?? 0) !== 0)
    error('STAMPS_INPUT', 'stamps.input must be an integer input starting at 0.', 'stamps/input');
  else if (isGoal(goal) && typeof input.maximum === 'number' && input.maximum < goal)
    error('STAMPS_MAX', `The stamps input must allow at least ${goal}.`, 'stamps/input');
  else if (isGoal(goal) && typeof input.maximum === 'number' && input.maximum < maxStamps(goal))
    warn(
      'STAMPS_MAX_LOW',
      `The stamps input stops at ${input.maximum}; ${maxStamps(goal)} holds a full card plus the carry-over.`,
      'stamps/input',
    );

  const art = isRecord(block.art) ? block.art : {};
  if (typeof art.filled !== 'string' || typeof art.empty !== 'string')
    error('STAMPS_ART', 'Add stamps/filled.png and stamps/empty.png.', 'stamps/art');
  if (assetNames.some((n) => STRIP_LOCALIZED.test(n)))
    error('STAMPS_LOCALIZED', 'Stamps draw one strip. Remove localized strips.');

  if (passJson) {
    if (!STRIP_STYLES.some((s) => isRecord(passJson[s])))
      error(
        'STAMPS_STYLE',
        'Stamps need a style with a strip: store card, coupon or event ticket.',
      );
    for (const style of STRIP_STYLES) {
      const dict = passJson[style];
      if (isRecord(dict) && Array.isArray(dict.primaryFields) && dict.primaryFields.length > 0)
        warn('STAMPS_PRIMARY', 'Primary fields cover the first stamps.');
    }
  }

  const stampInput = typeof block.input === 'string' ? block.input : '';
  const bindings = manifest.bindings ?? [];
  const reading = new Set<string>();
  for (const b of bindings) {
    const f = fieldOf(b);
    if (f?.prop === 'value' && readsStamps(b, stampInput)) reading.add(f.key);
  }
  const staticMessage = new Set<string>();
  if (passJson)
    for (const style of STRIP_STYLES) {
      const dict = passJson[style];
      if (!isRecord(dict)) continue;
      for (const group of Object.values(dict))
        if (Array.isArray(group))
          for (const f of group)
            if (isRecord(f) && typeof f.changeMessage === 'string')
              staticMessage.add(String(f.key));
    }
  let tellsReady = false;
  bindings.forEach((b, i) => {
    const f = fieldOf(b);
    if (f?.prop !== 'changeMessage') return;
    if (mentionsReady(b.when)) tellsReady = true;
    else if (reading.has(f.key))
      warn(
        'STAMPS_CHATTY',
        'This changeMessage fires on every stamp. Show it only when pass.stamps.ready.',
        `bindings/${i}`,
      );
  });
  for (const key of staticMessage)
    if (reading.has(key))
      warn(
        'STAMPS_CHATTY',
        'This changeMessage fires on every stamp. Show it only when pass.stamps.ready.',
        `fields/${key}`,
      );
  if (!tellsReady) warn('STAMPS_SILENT', 'No field tells holders a reward is ready.');

  // A scan take on the count redeems the reward: it takes the goal, so extra stamps carry over.
  const scan = isRecord(manifest.scan) ? manifest.scan : {};
  const actions = Array.isArray(scan.actions) ? scan.actions : [];
  actions.forEach((a, i) => {
    if (
      isRecord(a) &&
      a.kind === 'take' &&
      a.input === stampInput &&
      isGoal(goal) &&
      a.amount !== goal
    )
      error(
        'SCAN_STAMPS_GOAL',
        `Redeeming takes the goal: set the amount to ${goal}.`,
        `scan.actions.${i}.amount`,
      );
  });
  return issues;
}
