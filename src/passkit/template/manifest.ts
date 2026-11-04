import { Validator } from '@cfworker/json-schema';
import type { BehaviorRegistry } from '../behaviors/registry.ts';
import type {
  Binding,
  Condition,
  Expr,
  Json,
  PassJson,
  Personalization,
  TemplateManifest,
  ValidationIssue,
} from '../types.ts';
import { checkExpr, conditionInputs, evaluate, exprReferences, isEmpty } from './expr.ts';
import { BINDING_STYLE_GROUPS, isAllowedPointer } from './pointer.ts';
import { validateRequires } from './requires.ts';

/** Image target: drops the slot's files from the bundle when the binding's condition says so. */
export interface ImageTarget {
  image: string;
}

/** JSON Schema keywords that can burn CPU or reach outside the schema. */
const UNSAFE_KEYWORDS = new Set([
  'pattern',
  'patternProperties',
  '$dynamicRef',
  '$recursiveRef',
  '$dynamicAnchor',
  '$recursiveAnchor',
]);
const SCHEMA_MAPS = new Set(['properties', '$defs', 'definitions', 'dependentSchemas']);
const MAX_SCHEMA_NODES = 500;
const MAX_ENUM = 500;

export interface ValidateManifestOptions {
  /** Baked templates may use `pattern`; uploaded ones may not. */
  allowPattern?: boolean;
  passJson?: PassJson;
  behaviors?: BehaviorRegistry;
  /** Asset names in the package, to check previewOnlyAssets. */
  assetNames?: string[];
}

function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scanSchema(
  node: unknown,
  path: string,
  options: ValidateManifestOptions,
  state: { nodes: number },
  report: (code: string, message: string, path: string) => void,
): void {
  if (Array.isArray(node)) {
    for (const [i, child] of node.entries())
      scanSchema(child, `${path}/${i}`, options, state, report);
    return;
  }
  if (!isRecord(node)) return;
  if (++state.nodes > MAX_SCHEMA_NODES) {
    if (state.nodes === MAX_SCHEMA_NODES + 1)
      report('SCHEMA_SIZE', `Inputs schema has more than ${MAX_SCHEMA_NODES} nodes.`, path);
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (UNSAFE_KEYWORDS.has(key) && !(key === 'pattern' && options.allowPattern))
      report('SCHEMA_KEYWORD', `Inputs schema keyword "${key}" is not allowed.`, `${path}/${key}`);
    else if (key === '$ref' && !(typeof child === 'string' && child.startsWith('#')))
      report('SCHEMA_KEYWORD', 'Only local $ref is allowed.', `${path}/${key}`);
    else if (key === 'format' && child === 'regex')
      report('SCHEMA_KEYWORD', 'format "regex" is not allowed.', `${path}/${key}`);
    else if (key === 'enum' && Array.isArray(child) && child.length > MAX_ENUM)
      report('SCHEMA_SIZE', `enum has more than ${MAX_ENUM} values.`, `${path}/${key}`);
    // Annotations are data, not schemas.
    if (key === 'x-enumLabels' || key === 'default' || key === 'const' || key === 'examples')
      continue;
    if (SCHEMA_MAPS.has(key) && isRecord(child)) {
      for (const [name, sub] of Object.entries(child))
        scanSchema(sub, `${path}/${key}/${name}`, options, state, report);
      continue;
    }
    scanSchema(child, `${path}/${key}`, options, state, report);
  }
}

function targetOf(binding: Binding): Record<string, unknown> {
  return binding.to as unknown as Record<string, unknown>;
}

/** Static checks for a manifest. Errors block upload; warnings are shown to the author. */
export function validateManifest(
  manifest: TemplateManifest,
  options: ValidateManifestOptions = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (severity: 'error' | 'warning') => (code: string, message: string, path?: string) =>
    issues.push({ severity, code, message, ...(path ? { path } : {}) });
  const error = add('error');
  const warn = add('warning');

  if ((manifest as { schema?: unknown }).schema !== 1)
    error('MANIFEST_SCHEMA', 'schema must be 1.', 'schema');
  if (typeof manifest.name !== 'string' || !manifest.name.trim())
    error('MANIFEST_NAME', 'name is required.', 'name');
  if (!isRecord(manifest.inputs) || manifest.inputs.type !== 'object') {
    error('MANIFEST_INPUTS', 'inputs must be a JSON Schema object.', 'inputs');
    return issues;
  }
  issues.push(...validateRequires(manifest, options.passJson));
  scanSchema(manifest.inputs, 'inputs', options, { nodes: 0 }, error);
  const properties = isRecord(manifest.inputs.properties) ? manifest.inputs.properties : {};
  const inputNames = new Set(Object.keys(properties));
  if (inputNames.has('pass'))
    error(
      'INPUT_RESERVED',
      '"pass" is reserved for server values; rename the input.',
      'inputs.properties.pass',
    );

  const sample = manifest.sample ?? {};
  try {
    const result = new Validator(manifest.inputs as never, '2020-12', false).validate(
      applyDefaults(manifest, sample),
    );
    for (const e of leafErrors(result.errors))
      error('SAMPLE_INVALID', `sample: ${e.error}`, `sample${e.instanceLocation.slice(1)}`);
  } catch (e) {
    error('MANIFEST_INPUTS', `inputs schema cannot be compiled: ${(e as Error).message}`, 'inputs');
  }

  const lookupTables = new Set(Object.keys(manifest.lookups ?? {}));
  const checkExprRefs = (expr: Expr | undefined, path: string) => {
    if (expr === undefined) return;
    const problem = checkExpr(expr);
    if (problem) {
      error('EXPR', problem, path);
      return;
    }
    for (const m of (typeof expr === 'string' ? expr : '').matchAll(/\bpass\.(\w+)/g))
      if (m[1] !== 'scanCode') warn('EXPR_PASS', `Unknown pass value "${m[1]}".`, path);
    const refs = exprReferences(expr);
    for (const name of refs.inputs)
      if (!inputNames.has(name)) warn('EXPR_INPUT', `Unknown input "${name}".`, path);
    for (const name of refs.lookups)
      if (!lookupTables.has(name)) error('EXPR_LOOKUP', `Unknown lookup table "${name}".`, path);
  };
  const checkCondition = (condition: Condition | undefined, path: string) => {
    if (!condition) return;
    for (const name of conditionInputs(condition))
      if (!inputNames.has(name)) warn('COND_INPUT', `Unknown input "${name}".`, path);
  };

  const fieldKeys = new Set<string>();
  const actionIds = new Set<string>();
  const imageSlots = new Set<string>();
  if (options.passJson) {
    for (const style of BINDING_STYLE_GROUPS.styles) {
      const dict = options.passJson[style];
      if (!isRecord(dict)) continue;
      for (const group of BINDING_STYLE_GROUPS.groups) {
        const fields = (dict as Record<string, unknown>)[group];
        if (Array.isArray(fields))
          for (const f of fields) fieldKeys.add(String((f as { key?: string }).key));
      }
    }
    for (const a of options.passJson.featuredActions ?? [])
      actionIds.add(String((a as { identifier?: string }).identifier));
  }
  for (const name of options.assetNames ?? []) {
    const slot = /^(?:[\w-]+\.lproj\/)?([A-Za-z]+)(?:@[23]x)?\.png$/.exec(name)?.[1];
    if (slot) imageSlots.add(slot);
  }

  (manifest.bindings ?? []).forEach((binding, i) => {
    const path = `bindings/${i}`;
    const to = targetOf(binding);
    checkExprRefs(binding.value, `${path}/value`);
    checkCondition(binding.when, `${path}/when`);
    checkCondition(binding.remove, `${path}/remove`);
    if ('field' in to) {
      const keys = Array.isArray(to.field) ? (to.field as string[]) : [String(to.field)];
      if (options.passJson)
        for (const key of keys)
          if (!fieldKeys.has(key)) warn('BINDING_TARGET', `No field with key "${key}".`, path);
    } else if ('action' in to) {
      if (options.passJson && !actionIds.has(String(to.action)))
        warn('BINDING_TARGET', `No featured action "${String(to.action)}".`, path);
    } else if ('barcode' in to) {
      if (to.barcode !== '*' && !Number.isInteger(to.barcode))
        error('BINDING_TARGET', 'barcode must be an index or "*".', path);
    } else if ('pointer' in to) {
      const problem = isAllowedPointer(String(to.pointer));
      if (problem) error('BINDING_POINTER', problem, path);
    } else if ('image' in to) {
      if (options.assetNames && !imageSlots.has(String(to.image)))
        warn('BINDING_TARGET', `No image for slot "${String(to.image)}".`, path);
    } else error('BINDING_TARGET', 'Unknown binding target.', path);
    if (binding.value === undefined && binding.remove === undefined && !('image' in to))
      warn('BINDING_EMPTY', 'Binding has neither value nor remove.', path);
  });

  const display = manifest.display;
  if (!display || display.title === undefined)
    error('DISPLAY', 'display.title is required.', 'display');
  else {
    checkExprRefs(display.title, 'display/title');
    checkExprRefs(display.subtitle, 'display/subtitle');
    checkExprRefs(display.status, 'display/status');
    for (const name of display.search ?? [])
      if (!inputNames.has(name))
        warn('DISPLAY_SEARCH', `Unknown input "${name}".`, 'display/search');
  }

  for (const [i, use] of (manifest.behaviors ?? []).entries()) {
    const path = `behaviors/${i}`;
    if (!options.behaviors) continue;
    const plugin = options.behaviors.get(use.use);
    if (!plugin) {
      error('BEHAVIOR', `Unknown behavior "${use.use}".`, path);
      continue;
    }
    if (plugin.version !== use.version)
      warn(
        'BEHAVIOR_VERSION',
        `${use.use} is version ${plugin.version}, template wants ${use.version}.`,
        path,
      );
    const result = new Validator(plugin.configSchema as never, '2020-12', false).validate(
      use.config,
    );
    for (const e of result.errors)
      error(
        'BEHAVIOR_CONFIG',
        `${use.use}: ${e.error}`,
        `${path}/config${e.instanceLocation.slice(1)}`,
      );
  }

  if (manifest.messaging !== undefined) checkMessaging(manifest, inputNames, options, error);

  if (manifest.previewOnlyAssets && options.assetNames) {
    for (const name of manifest.previewOnlyAssets)
      if (!options.assetNames.includes(name))
        warn(
          'PREVIEW_ASSET',
          `previewOnlyAssets lists missing file "${name}".`,
          'previewOnlyAssets',
        );
  }
  return issues;
}

const MESSAGE_CHANGE = '%@';

/** `messaging.input` must exist and drive a back field that shows its new value as the message. */
function checkMessaging(
  manifest: TemplateManifest,
  inputNames: Set<string>,
  options: ValidateManifestOptions,
  error: (code: string, message: string, path?: string) => void,
): void {
  const input = (manifest.messaging as { input?: unknown } | null)?.input;
  if (typeof input !== 'string' || !inputNames.has(input)) {
    error('MESSAGING_INPUT', `messaging.input "${String(input)}" is not an input.`, 'messaging');
    return;
  }
  if (!options.passJson) return;
  const messageKeys = new Set<string>();
  for (const style of BINDING_STYLE_GROUPS.styles) {
    const dict = options.passJson[style];
    const back = isRecord(dict) ? (dict as Record<string, unknown>).backFields : undefined;
    if (Array.isArray(back))
      for (const f of back as { key?: unknown; changeMessage?: unknown }[])
        if (f.changeMessage === MESSAGE_CHANGE) messageKeys.add(String(f.key));
  }
  const bound = (manifest.bindings ?? []).some((binding) => {
    const to = targetOf(binding);
    if (!('field' in to) || 'prop' in to) return false;
    const keys = Array.isArray(to.field) ? (to.field as string[]) : [String(to.field)];
    return (
      keys.some((key) => messageKeys.has(key)) &&
      binding.value !== undefined &&
      exprReferences(binding.value).inputs.includes(input)
    );
  });
  if (!bound)
    error(
      'MESSAGING_FIELD',
      `Bind "${input}" to a back field whose changeMessage is "%@".`,
      'messaging',
    );
}

/** cfworker also reports every ancestor of a failing value; keep the innermost errors. */
function leafErrors<T extends { instanceLocation: string }>(errors: T[]): T[] {
  return errors.filter(
    (e) => !errors.some((o) => o !== e && o.instanceLocation.startsWith(`${e.instanceLocation}/`)),
  );
}

/** Fills top-level `default`s from the inputs schema. Does not mutate `input`. */
export function applyDefaults(manifest: TemplateManifest, input: Personalization): Personalization {
  const out: Personalization = { ...input };
  const properties = isRecord(manifest.inputs.properties) ? manifest.inputs.properties : {};
  for (const [name, schema] of Object.entries(properties)) {
    if (out[name] !== undefined && out[name] !== null) continue;
    if (isRecord(schema) && schema.default !== undefined) out[name] = schema.default;
  }
  return out;
}

/** Validates against the inputs schema after defaults. Returns the problems (empty when valid). */
export function checkInput(manifest: TemplateManifest, input: Personalization): ValidationIssue[] {
  const validator = new Validator(manifest.inputs as never, '2020-12', false);
  const result = validator.validate(applyDefaults(manifest, input));
  return leafErrors(result.errors).map((e) => ({
    severity: 'error' as const,
    code: 'INPUT',
    message: e.error,
    path: e.instanceLocation.replace(/^#\/?/, ''),
  }));
}

export interface DisplayProjection {
  title: string;
  subtitle: string | null;
  status: string | null;
  /** Lowercased, joined search terms. */
  search: string;
}

function text(value: Json | undefined): string | null {
  if (isEmpty(value)) return null;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** List-row projection stored on the pass row. */
export function projectDisplay(
  manifest: TemplateManifest,
  input: Personalization,
): DisplayProjection {
  const full = applyDefaults(manifest, input);
  const scope = { input: full, lookups: manifest.lookups ?? {} };
  const ev = (expr: Expr | undefined) => (expr === undefined ? null : text(evaluate(expr, scope)));
  const search = (manifest.display.search ?? [])
    .map((name) => text(full[name]))
    .filter((v): v is string => v !== null)
    .join(' ')
    .toLowerCase();
  return {
    title: ev(manifest.display.title) ?? '',
    subtitle: ev(manifest.display.subtitle),
    status: ev(manifest.display.status),
    search,
  };
}
