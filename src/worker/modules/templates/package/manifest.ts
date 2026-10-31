import { Validator } from '@cfworker/json-schema';
import type { BehaviorRegistry } from '../../../../passkit/behaviors/registry.ts';
import { isAllowedPointer, parsePointer } from '../../../../passkit/template/pointer.ts';
import type {
  Json,
  PassField,
  PassJson,
  TemplateManifest,
  ValidationIssue,
} from '../../../../passkit/types.ts';
import { isSafePattern, needsInputBound, PATTERN_INPUT_MAX } from './safe-regex.ts';
import { stylesOf } from './slots.ts';

const GROUPS = [
  'headerFields',
  'primaryFields',
  'secondaryFields',
  'auxiliaryFields',
  'footerFields',
  'backFields',
  'additionalInfoFields',
] as const;

export const MAX_MANIFEST_BYTES = 64 * 1024;

/**
 * Schema keywords uploaded manifests may use. `pattern` is checked separately (safe regex and a
 * bounded maxLength); no references.
 */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'enum',
  'const',
  'title',
  'description',
  'default',
  'examples',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'items',
  'additionalProperties',
  'format',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'dependentRequired',
  'pattern',
  '$schema',
]);

/** Pass.json roots whose contents are per-pass data. Server-owned keys stay denied by the engine. */
const DATA_ROOTS = new Set([
  'relevantDates',
  'semantics',
  'locations',
  'beacons',
  'userInfo',
  'nfc',
  'upcomingPassInformation',
  'preferredStyleSchemes',
  'maxDistance',
]);

const POINTERS = new Set([
  '/logoText',
  '/relevantDate',
  '/expirationDate',
  '/voided',
  '/foregroundColor',
  '/backgroundColor',
  '/labelColor',
  '/stripColor',
  '/description',
  '/groupingIdentifier',
  '/eventLogoText',
]);

function pointerAllowed(pointer: unknown): boolean {
  if (typeof pointer !== 'string') return false;
  if (POINTERS.has(pointer)) return true;
  if (isAllowedPointer(pointer) !== null) return false;
  const root = parsePointer(pointer)?.[0] ?? '';
  return DATA_ROOTS.has(root) || /^\/[A-Za-z]+\/transitType$/.test(pointer);
}

export function fieldsOf(pass: PassJson): PassField[] {
  const out: PassField[] = [];
  for (const style of stylesOf(pass)) {
    const dict = pass[style] as Record<string, unknown>;
    for (const group of GROUPS) {
      const fields = dict[group];
      if (Array.isArray(fields))
        for (const f of fields)
          if (f && typeof f === 'object' && 'key' in f) out.push(f as PassField);
    }
  }
  return out;
}

function text(value: Json | undefined): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Manifest for packages without one: every field becomes a string input bound to itself. */
export function defaultManifest(pass: PassJson, name: string): TemplateManifest {
  const properties: Record<string, Json> = {};
  const sample: Record<string, Json> = {};
  const bindings: TemplateManifest['bindings'] = [];
  let titleKey: string | undefined;
  for (const field of fieldsOf(pass)) {
    if (field.key in properties) continue;
    properties[field.key] = {
      type: 'string',
      'x-label': field.label ?? field.key,
      'x-order': Object.keys(properties).length,
    };
    sample[field.key] = text(field.value);
    bindings.push({ to: { field: field.key }, value: `{{${field.key}}}` });
    titleKey ??= field.key;
  }
  return {
    schema: 1,
    name,
    inputs: { type: 'object', properties },
    sample,
    bindings,
    display: { title: titleKey ? `{{${titleKey}}}` : { const: name } },
  };
}

type Push = (issue: ValidationIssue) => void;

function checkSchemaNode(
  node: unknown,
  path: string,
  depth: number,
  count: { n: number },
  push: Push,
) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    if (typeof node !== 'boolean')
      push({ severity: 'error', code: 'SCHEMA_SHAPE', message: 'Schema must be an object.', path });
    return;
  }
  if (++count.n > 500 || depth > 6) {
    push({
      severity: 'error',
      code: 'SCHEMA_SIZE',
      message: 'Input schema is too large or deep.',
      path,
    });
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('x-')) continue;
    if (!ALLOWED_KEYWORDS.has(key)) {
      push({
        severity: 'error',
        code: 'SCHEMA_KEYWORD',
        message: `Schema keyword ${key} is not allowed in uploaded templates.`,
        path: `${path}.${key}`,
      });
      continue;
    }
    if (key === 'pattern') {
      const bound = (node as Record<string, unknown>).maxLength;
      const bounded = typeof bound === 'number' && bound <= PATTERN_INPUT_MAX;
      if (typeof value !== 'string' || !isSafePattern(value))
        push({
          severity: 'error',
          code: 'SCHEMA_PATTERN',
          message: 'Pattern is too complex. Use simple character classes and bounded repeats.',
          path: `${path}.pattern`,
        });
      else if (!bounded && needsInputBound(value))
        push({
          severity: 'error',
          code: 'SCHEMA_PATTERN',
          message: `A pattern needs maxLength of at most ${PATTERN_INPUT_MAX}.`,
          path: `${path}.pattern`,
        });
    } else if (key === 'dependentRequired') {
      const ok =
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length <= 50 &&
        Object.values(value).every(
          (v) => Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === 'string'),
        );
      if (!ok)
        push({
          severity: 'error',
          code: 'SCHEMA_SHAPE',
          message: 'dependentRequired must map names to lists of names.',
          path: `${path}.dependentRequired`,
        });
    } else if (key === 'properties' && value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value))
        checkSchemaNode(child, `${path}.properties.${name}`, depth + 1, count, push);
    } else if (key === 'items' || key === 'additionalProperties' || key === 'not') {
      checkSchemaNode(value, `${path}.${key}`, depth + 1, count, push);
    } else if ((key === 'oneOf' || key === 'anyOf' || key === 'allOf') && Array.isArray(value)) {
      for (const [i, child] of value.entries())
        checkSchemaNode(child, `${path}.${key}.${i}`, depth + 1, count, push);
    }
  }
}

function checkCondition(value: unknown, path: string, depth: number, push: Push): void {
  const bad = () => {
    push({ severity: 'error', code: 'MANIFEST_CONDITION', message: 'Invalid condition.', path });
  };
  if (!value || typeof value !== 'object' || depth > 5) {
    bad();
    return;
  }
  const c = value as Record<string, unknown>;
  if ('all' in c || 'any' in c) {
    const list = c.all ?? c.any;
    if (!Array.isArray(list)) {
      bad();
      return;
    }
    for (const [i, child] of list.entries()) checkCondition(child, `${path}.${i}`, depth + 1, push);
  } else if ('not' in c) checkCondition(c.not, path, depth + 1, push);
  else if (typeof c.input !== 'string') bad();
}

export interface ManifestOptions {
  /** Uploaded manifests get the restricted schema keywords and the pointer allowlist. */
  uploaded: boolean;
  behaviors?: BehaviorRegistry;
}

/** Shape, schema keywords, target resolution, behaviors and sample-vs-schema. */
export function validateManifest(
  manifest: TemplateManifest,
  pass: PassJson,
  options: ManifestOptions,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push: Push = (i) => issues.push(i);
  const error = (code: string, message: string, path?: string) =>
    push({ severity: 'error', code, message, ...(path ? { path } : {}) });
  const warn = (code: string, message: string, path?: string) =>
    push({ severity: 'warning', code, message, ...(path ? { path } : {}) });

  const m = manifest as unknown as Record<string, unknown>;
  if (JSON.stringify(manifest).length > MAX_MANIFEST_BYTES)
    error('MANIFEST_SIZE', 'Manifest is larger than 64 KB.');
  if (m.schema !== 1) error('MANIFEST_SCHEMA', 'Manifest schema must be 1.', 'schema');
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 120)
    error('MANIFEST_NAME', 'Manifest needs a name of 1 to 120 characters.', 'name');
  const inputs = m.inputs as Record<string, unknown> | undefined;
  if (!inputs || typeof inputs !== 'object' || inputs.type !== 'object') {
    error('MANIFEST_INPUTS', 'inputs must be an object schema.', 'inputs');
    return issues;
  }
  if (options.uploaded) checkSchemaNode(inputs, 'inputs', 0, { n: 0 }, push);
  if (!m.sample || typeof m.sample !== 'object' || Array.isArray(m.sample))
    error('MANIFEST_SAMPLE', 'sample must be an object.', 'sample');
  const display = m.display as Record<string, unknown> | undefined;
  if (!display || display.title === undefined)
    error('MANIFEST_DISPLAY', 'display.title is required.', 'display.title');
  if (!Array.isArray(m.bindings)) {
    error('MANIFEST_BINDINGS', 'bindings must be an array.', 'bindings');
    return issues;
  }
  if (m.bindings.length > 200) error('MANIFEST_BINDINGS', 'At most 200 bindings.', 'bindings');

  const keys = new Set(fieldsOf(pass).map((f) => f.key));
  const actions = new Set(
    (Array.isArray(pass.featuredActions) ? pass.featuredActions : []).map(
      (a) => (a as { identifier?: string }).identifier,
    ),
  );
  for (const [i, raw] of m.bindings.entries()) {
    const path = `bindings.${i}`;
    const b = raw as Record<string, unknown> | null;
    const to = b?.to as Record<string, unknown> | undefined;
    if (!b || !to || typeof to !== 'object') {
      error('BINDING_SHAPE', 'Binding needs a target.', path);
      continue;
    }
    if (
      b.value !== undefined &&
      typeof b.value !== 'string' &&
      !(b.value && typeof b.value === 'object' && 'const' in b.value)
    )
      error('BINDING_VALUE', 'Binding value must be text or { const }.', `${path}.value`);
    for (const cond of ['when', 'remove'] as const)
      if (b[cond] !== undefined) checkCondition(b[cond], `${path}.${cond}`, 0, push);
    if ('field' in to) {
      const list = Array.isArray(to.field) ? to.field : [to.field];
      for (const key of list)
        if (typeof key !== 'string' || !keys.has(key))
          warn('BINDING_TARGET', `No field ${String(key)} in pass.json.`, `${path}.to`);
    } else if ('action' in to) {
      if (!actions.has(to.action as string))
        warn('BINDING_TARGET', `No featured action ${String(to.action)}.`, `${path}.to`);
    } else if ('barcode' in to) {
      const count = Array.isArray(pass.barcodes) ? pass.barcodes.length : 0;
      if (typeof to.barcode === 'number' ? to.barcode >= count : to.barcode !== '*' || count === 0)
        warn('BINDING_TARGET', 'No matching barcode in pass.json.', `${path}.to`);
    } else if ('pointer' in to) {
      if (options.uploaded && !pointerAllowed(to.pointer))
        error('BINDING_POINTER', `Pointer ${String(to.pointer)} is not allowed.`, `${path}.to`);
    } else error('BINDING_SHAPE', 'Unknown binding target.', `${path}.to`);
  }

  for (const [i, use] of (manifest.behaviors ?? []).entries()) {
    const path = `behaviors.${i}`;
    const plugin = options.behaviors?.get(use.use);
    if (!plugin) {
      error('BEHAVIOR_UNKNOWN', `Unknown behavior ${use.use}.`, path);
      continue;
    }
    if (plugin.version !== use.version)
      warn('BEHAVIOR_VERSION', `${use.use} is at version ${plugin.version}.`, path);
    try {
      const result = new Validator(plugin.configSchema as never, '2020-12', false).validate(
        use.config,
      );
      if (!result.valid)
        error(
          'BEHAVIOR_CONFIG',
          `Invalid config for ${use.use}: ${result.errors[0]?.error}`,
          `${path}.config`,
        );
    } catch {
      error('BEHAVIOR_CONFIG', `Config schema of ${use.use} cannot be applied.`, `${path}.config`);
    }
  }

  if (!issues.some((x) => x.severity === 'error' && x.code.startsWith('SCHEMA'))) {
    try {
      const result = new Validator(inputs as never, '2020-12', false).validate(
        manifest.sample ?? {},
      );
      for (const e of result.errors.slice(0, 5))
        error('SAMPLE_INVALID', `sample ${e.instanceLocation}: ${e.error}`, 'sample');
    } catch {
      error('MANIFEST_INPUTS', 'inputs is not a valid JSON Schema.', 'inputs');
    }
  }
  return issues;
}
