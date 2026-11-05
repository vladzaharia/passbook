/** Text-level rules of `scanDisplayIssues` (DM 6.2 step 3): caps, bindings, filters, secrets, the band title. */
import type { PassJson, ScanAction, TemplateManifest, ValidationIssue } from '../../types.ts';
import { DENSITY, hasNameToken, literalPart } from './density.ts';
import { graphemeLength } from './format.ts';
import type { ScanDisplayDoc } from './schema.ts';
import { type InputSchema, PASS_KEYS, passFields, SECRET_PASS_KEYS, scanLevel } from './scope.ts';
import { interpolationCount, isKnownFilter, parseParts, splitPath } from './text.ts';
import { type ExprSlot, sourcesOf, type TextSlot } from './walk.ts';

/** Words that read as a verdict. Shared by the save check and the render-time name check. */
export const VERDICT_WORDS = [
  'refused',
  'denied',
  'invalid',
  'expired',
  'voided',
  'not valid',
  'already',
  'stop',
  'refunded',
  'cancelled',
  'blocked',
  'banned',
] as const;

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const VERDICT_PATTERNS = VERDICT_WORDS.map(
  (word) => new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(' ', '\\s+')}($|[^\\p{L}\\p{N}])`, 'u'),
);

/** Whole-word, case- and accent-insensitive. */
export const hasVerdictWord = (text: string): boolean => {
  const folded = fold(text);
  return VERDICT_PATTERNS.some((pattern) => pattern.test(folded));
};

export interface Ctx {
  manifest: TemplateManifest;
  doc: ScanDisplayDoc;
  passJson: PassJson | undefined;
  assetNames: string[] | undefined;
  inputs: Record<string, InputSchema>;
  secrets: Set<string>;
  hiddenFields: Set<string>;
  fieldKeys: Set<string> | null;
  actions: ScanAction[];
  changed: Set<string>;
  push: (severity: 'error' | 'warning', code: string, path: string, message: string) => void;
}

export const issueOf = (
  severity: ValidationIssue['severity'],
  code: string,
  path: string,
  message: string,
): ValidationIssue => ({
  severity,
  code: `SCAN_DISPLAY_${code}`,
  message,
  path: `scan.display.${path}`,
});

const HOLDER_PARTS = new Set(['name', 'firstName', 'initials']);

/** Checks one binding path. Returns the input it reads, if any. */
export function checkPath(ctx: Ctx, path: string, at: string): string | null {
  const split = splitPath(path);
  if (!split) return null;
  const { root, rest } = split;
  const first = rest[0];
  if (root === 'pass') {
    if (first && SECRET_PASS_KEYS.has(first))
      ctx.push('error', 'SECRET', at, `pass.${first} is never shown on scanners.`);
    else if (first && !PASS_KEYS.some((k) => k.key === first))
      ctx.push('warning', 'PATH', at, `Unknown pass value "${first}".`);
    return null;
  }
  if (root === 'inputs') {
    if (!first) return null;
    if (ctx.secrets.has(first)) {
      ctx.push('error', 'SECRET', at, `${first} is never shown on scanners.`);
      return null;
    }
    if (!(first in ctx.inputs)) ctx.push('warning', 'PATH', at, `Unknown input "${first}".`);
    return first;
  }
  if (root === 'fields' && first) {
    if (ctx.hiddenFields.has(first))
      ctx.push('error', 'SECRET', at, `Field "${first}" is never shown on scanners.`);
    else if (ctx.fieldKeys && !ctx.fieldKeys.has(first))
      ctx.push('warning', 'PATH', at, `Unknown field "${first}".`);
  } else if (root === 'holder' && first && !HOLDER_PARTS.has(first)) {
    ctx.push('warning', 'PATH', at, `Unknown holder value "${first}".`);
  } else if (root === 'lookups' && first && !(first in (ctx.manifest.lookups ?? {}))) {
    ctx.push('warning', 'PATH', at, `Unknown lookup "${first}".`);
  }
  if (root === 'history' && first === 'ledger' && rest[1]) {
    const input = rest[1];
    if (!ctx.changed.has(input))
      ctx.push('error', 'HISTORY_INPUT', at, `No action changes ${input}, so it has no ledger.`);
  }
  return null;
}

/** Caps, bindings, filters and secrets of every text and expression. */
export function checkTexts(ctx: Ctx, texts: TextSlot[], exprs: ExprSlot[]): void {
  for (const slot of texts) {
    const sources = sourcesOf(slot.text);
    if (typeof slot.text === 'object') checkBinding(ctx, slot.text.count, `${slot.path}.count`);
    const reads: (string | null)[] = [];
    for (const source of sources) {
      reads.push(...checkBinding(ctx, source, slot.path));
      if (!source.includes('{{')) checkLiteral(ctx, source, slot);
    }
    const inputs = reads.filter((name): name is string => name !== null);
    if (
      slot.role === 'door' &&
      inputs.length > 0 &&
      inputs.length === reads.length &&
      inputs.every((name) => levelOf(ctx, name) !== 'door')
    )
      ctx.push(
        'warning',
        'ROLE_EMPTY',
        slot.path,
        'Door never sees this: it binds desk-only inputs.',
      );
  }
  for (const slot of exprs) checkBinding(ctx, slot.expr, slot.path);
}

function levelOf(ctx: Ctx, name: string): 'door' | 'desk' | 'manager' | 'hidden' {
  const schema = ctx.inputs[name];
  return schema ? scanLevel(schema) : 'door';
}

function checkBinding(ctx: Ctx, source: string, at: string): (string | null)[] {
  const { parts, error } = parseParts(source);
  if (!parts) {
    ctx.push('error', 'EXPR', at, `${error}.`);
    return [];
  }
  if (interpolationCount(source) > 8) ctx.push('error', 'EXPR', at, 'Use at most 8 bindings.');
  const reads: (string | null)[] = [];
  for (const part of parts) {
    if (!part.path) continue;
    if (part.filter !== undefined && !isKnownFilter(part.filter))
      ctx.push(
        'error',
        'FILTER',
        at,
        part.filter === 'html' || part.filter === 'url'
          ? `Filter "${part.filter}" is not for scanner text.`
          : `Unknown filter "${part.filter}".`,
      );
    reads.push(checkPath(ctx, part.path, at));
  }
  return reads;
}

function checkLiteral(ctx: Ctx, source: string, slot: TextSlot): void {
  if (slot.zone === 'title') return;
  if (slot.cap !== null && graphemeLength(source) > slot.cap)
    ctx.push('error', 'TEXT_LENGTH', slot.path, `Use ${slot.cap} characters at most.`);
  if (hasVerdictWord(source))
    ctx.push(
      'warning',
      'VERDICT_WORD',
      slot.path,
      'This reads like a result. The scanner shows results.',
    );
}

/** The holder source must be one binding to a string input, a field, or the pass title. */
export function checkHolder(ctx: Ctx): void {
  const source = ctx.doc.holder;
  if (source === undefined) return;
  const { parts } = parseParts(source);
  const part = parts?.length === 1 ? parts[0] : undefined;
  const split = part?.path && !part.filter ? splitPath(part.path) : null;
  if (!part || !split) {
    ctx.push('error', 'HOLDER', 'holder', 'Pick one field or input for the holder line.');
    return;
  }
  if (split.root === 'inputs') {
    const schema = ctx.inputs[split.rest[0] ?? ''];
    if (schema && schema.type !== undefined && schema.type !== 'string')
      ctx.push('error', 'HOLDER', 'holder', 'The holder line needs a text input.');
  } else if (split.root !== 'fields' && !(split.root === 'pass' && split.rest[0] === 'title')) {
    ctx.push(
      'error',
      'HOLDER',
      'holder',
      'The holder line needs an input, a field or the pass title.',
    );
  }
}

/** Whether the holder source can hold a person's name (DM 1.3). */
function holderCanBeName(ctx: Ctx): boolean {
  const source = ctx.doc.holder;
  if (source === undefined) return false;
  const { parts } = parseParts(source);
  const path = parts?.length === 1 ? parts[0]?.path : undefined;
  const split = path ? splitPath(path) : null;
  if (!split) return false;
  if (split.root === 'fields') return true;
  if (split.root !== 'inputs') return false;
  const schema = ctx.inputs[split.rest[0] ?? ''];
  return (
    !schema ||
    (schema.enum === undefined && (schema.type === undefined || schema.type === 'string'))
  );
}

/** `header.title` (base and variants): literal text plus the holder's name (R16). */
export function checkTitles(ctx: Ctx, texts: TextSlot[]): void {
  for (const slot of texts) {
    if (slot.zone !== 'title') continue;
    const sources = sourcesOf(slot.text);
    for (const source of sources) {
      const { parts } = parseParts(source);
      if (!parts) continue;
      for (const part of parts) {
        if (!part.path) continue;
        const split = splitPath(part.path);
        const name = split?.root === 'holder' && split.rest.length === 1 ? split.rest[0] : null;
        if ((name !== 'firstName' && name !== 'name') || part.filter !== undefined)
          ctx.push('error', 'TITLE', slot.path, 'The band title can add only the holder name.');
      }
      const literal = literalPart(source);
      const cap = hasNameToken(source) ? DENSITY.titleCapBesideName : DENSITY.titleCap;
      if (graphemeLength(literal) > cap)
        ctx.push('error', 'TITLE', slot.path, `Use ${cap} characters at most beside the name.`);
      if (hasVerdictWord(literal))
        ctx.push('error', 'TITLE', slot.path, 'A result word cannot be in the band title.');
    }
    if (hasNameToken(slot.text) && !holderCanBeName(ctx))
      ctx.push(
        'error',
        'TITLE',
        slot.path,
        'The holder line is not a name. Pick a name input first.',
      );
  }
}

export function buildFieldKeys(passJson: PassJson | undefined): Set<string> | null {
  return passJson ? new Set(passFields(passJson).map((f) => f.key)) : null;
}
