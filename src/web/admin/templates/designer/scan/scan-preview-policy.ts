import { exprReferences } from '@/passkit/template/expr.ts';
import { hasContactShape, isPrivateName } from '@/passkit/template/scan-display/privacy.ts';
import {
  type InputSchema,
  inputProps,
  inputVisibleTo,
  secretInputs,
} from '@/passkit/template/scan-display/scope.ts';
import { parseParts, pathTokens } from '@/passkit/template/scan-display/text.ts';
import type { Json, PassJson, ScanRole, TemplateManifest } from '@/passkit/types.ts';
import { PASS_STYLES } from '@/passkit/types.ts';
import { type DesignDoc, isRecord } from '../model.ts';

const PHONE = /(?:^|[^A-Za-z0-9])\+?\d[\d ().-]*\d(?=$|[^A-Za-z0-9])/g;
/** Dates, clock times and year ranges are not contact data, whatever their digit count. */
const BENIGN_DIGITS = [
  /(?<![\d-])\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?(?![\d-])/g,
  /(?<![\d.])\d{1,2}[./]\d{1,2}[./](?:19|20)\d{2}(?![\d.])/g,
  /(?<![\d-])(?:19|20)\d{2}\s?[-\u2013]\s?(?:(?:19|20)\d{2}|\d{2})(?![\d-])/g,
  /(?<![\d.:])(?:[01]?\d|2[0-3])[.:][0-5]\d(?![\d]|[.:]\d)/g,
];

/** A number this long reads as a phone or account number; amounts and counts stay shorter. */
export function safePreviewNumber(text: string): boolean {
  return (text.match(/\d/g) ?? []).length < 10;
}

/**
 * Authored text typed into the designer: stricter than what the scanner hides, because an author
 * has no reason to type a phone number or raw JSON into a label. Holder values are not judged by
 * their digits; see {@link safePreviewValue}.
 */
export function safePreviewText(value: string): boolean {
  if (value.includes('{{') || hasContactShape(value) || /^\s*[[{]/.test(value)) return false;
  const rest = BENIGN_DIGITS.reduce((text, pattern) => text.replace(pattern, ' '), value);
  return !Array.from(rest.matchAll(PHONE)).some(
    (match) => (match[0].match(/\d/g) ?? []).length >= 7,
  );
}

/** Why an authored literal is refused, in a sentence for the field; null when it is fine. */
export function textRejection(text: string, plain = false): string | null {
  if (plain && (text.includes('{{') || text.includes('}}')))
    return 'Plain text only. Fields are not allowed here.';
  if (!plain && text.includes('{{')) return 'Add fields with Insert field.';
  return safePreviewText(text) ? null : 'Remove contact details, links or private text.';
}

const RENDERED_TEXT_KEYS: Record<string, true> = {
  holder: true,
  initials: true,
  alt: true,
  title: true,
  meta: true,
  text: true,
  label: true,
  unit: true,
  detail: true,
  caption: true,
  empty: true,
  when: true,
  where: true,
  staff: true,
  refused: true,
  value: true,
  amount: true,
};

/** Rendered text is still checked: an unfinished draft can contain a literal contact or JSON. */
export function hasUnsafeRenderedText(value: unknown, key = ''): boolean {
  if (typeof value === 'string')
    return (
      Object.hasOwn(RENDERED_TEXT_KEYS, key) && (!safePreviewValue(value) || /^\s*[[{]/.test(value))
    );
  if (Array.isArray(value)) return value.some((item) => hasUnsafeRenderedText(item));
  if (value && typeof value === 'object')
    return Object.entries(value).some(([name, item]) => hasUnsafeRenderedText(item, name));
  return false;
}

const obj = (value: unknown): Record<string, Json> | undefined =>
  isRecord(value) ? (value as Record<string, Json>) : undefined;

/** A value in the preview scope: an expression left in it, an address or a link is not shown. */
export function safePreviewValue(value: string): boolean {
  return !value.includes('{{') && !hasContactShape(value);
}

function clean(value: Json | undefined, deniedKeys: Set<string>): Json | undefined {
  if (typeof value === 'string') return safePreviewValue(value) ? value : undefined;
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === undefined
  )
    return value;
  if (Array.isArray(value)) return value.map((item) => clean(item, deniedKeys) ?? null);
  const result: Record<string, Json> = {};
  for (const key of Object.keys(value)) {
    // Test the name before dereferencing the property, even for a nested or untyped object.
    if (isPrivateName(key) || deniedKeys.has(key) || !safePreviewValue(key)) continue;
    const next = clean(value[key], deniedKeys);
    if (next !== undefined) result[key] = next;
  }
  return result;
}

interface InputFilterState {
  deniedKeys: Set<string>;
  restricted: boolean;
}

function visibleInput(
  name: string,
  value: Json | undefined,
  schema: InputSchema,
  role: ScanRole,
  secrets: Set<string>,
  state: InputFilterState,
): Json | undefined {
  if (Array.isArray(value)) {
    const itemSchema = obj(schema.items);
    if (!itemSchema || !inputVisibleTo(name, itemSchema, role, secrets)) {
      state.restricted = true;
      return undefined;
    }
    return value.map((item) => visibleInput(name, item, itemSchema, role, secrets, state) ?? null);
  }
  const record = obj(value);
  if (!record) return value;
  const properties = obj(schema.properties);
  const result: Record<string, Json> = {};
  for (const key of Object.keys(record)) {
    const childSchema = obj(properties?.[key]);
    if (!childSchema || isPrivateName(key) || !inputVisibleTo(key, childSchema, role, secrets)) {
      state.deniedKeys.add(key);
      state.restricted = true;
      continue;
    }
    const next = visibleInput(key, record[key], childSchema, role, secrets, state);
    if (next !== undefined) result[key] = next;
  }
  return result;
}

/** Expression paths, including nested input paths, must all be visible for this role. */
function privateExpression(value: unknown, deniedKeys: Set<string>): boolean {
  if (typeof value !== 'string')
    return value !== undefined && value !== null && !(isRecord(value) && 'const' in value);
  const parsed = parseParts(value);
  if (!parsed.parts) return true;
  for (const part of parsed.parts) {
    if (!part.path) continue;
    const tokens = pathTokens(part.path);
    if (!tokens || tokens[0] === 'pass') return true;
    if (
      tokens.some((token) => {
        const key = token.replace(/^\[|\]$/g, '').trim();
        return deniedKeys.has(key) || isPrivateName(key);
      })
    )
      return true;
  }
  return false;
}

/** A partial designer document can be invalid while it is being edited. */
export function previewManifest(doc: DesignDoc): TemplateManifest {
  const source = doc.manifest;
  return {
    ...source,
    schema: 1,
    name: typeof source.name === 'string' && safePreviewText(source.name) ? source.name : 'Pass',
    inputs: (isRecord(source.inputs)
      ? source.inputs
      : { type: 'object', properties: {} }) as TemplateManifest['inputs'],
    sample: (isRecord(source.sample) ? source.sample : {}) as Record<string, Json>,
    bindings: (Array.isArray(source.bindings)
      ? source.bindings
      : []) as TemplateManifest['bindings'],
    display: (isRecord(source.display) && source.display.title !== undefined
      ? source.display
      : { title: 'Pass' }) as TemplateManifest['display'],
  } as TemplateManifest;
}

/** Copy only field keys and labels; never inspect a template's barcode, scan code or field values. */
export function previewPassFields(doc: DesignDoc, deniedKeys: Set<string> = new Set()): PassJson {
  const result: Record<string, unknown> = {};
  for (const style of PASS_STYLES) {
    const block = doc.passJson[style];
    if (!isRecord(block)) continue;
    const groups: Record<string, unknown> = {};
    for (const group of [
      'primaryFields',
      'secondaryFields',
      'auxiliaryFields',
      'headerFields',
      'additionalInfoFields',
      'footerFields',
      'backFields',
    ]) {
      const fields = block[group];
      if (!Array.isArray(fields)) continue;
      groups[group] = fields.flatMap((field: unknown) => {
        if (
          !isRecord(field) ||
          typeof field.key !== 'string' ||
          isPrivateName(field.key) ||
          deniedKeys.has(field.key)
        )
          return [];
        return [
          {
            key: field.key,
            ...(typeof field.label === 'string' && safePreviewText(field.label)
              ? { label: field.label }
              : {}),
          },
        ];
      });
    }
    result[style] = groups;
  }
  return result as PassJson;
}

/** A value used by a barcode is never a preview input, even if another field also binds it. */
export function previewSecrets(manifest: TemplateManifest): Set<string> {
  let denied: Set<string>;
  try {
    denied = secretInputs(manifest);
  } catch {
    denied = new Set(Object.keys(inputProps(manifest)));
  }
  for (const binding of manifest.bindings) {
    if (!('barcode' in binding.to) || binding.value === undefined) continue;
    try {
      for (const name of exprReferences(binding.value).inputs) denied.add(name);
    } catch {
      for (const name of Object.keys(inputProps(manifest))) denied.add(name);
    }
  }
  return denied;
}

/** Filter both synthetic inputs and draft policies on a real scope before the renderer sees them. */
function filteredInputs(
  manifest: TemplateManifest,
  role: ScanRole,
  source: Record<string, Json>,
  overrides: Record<string, Json> = {},
  defaults = false,
) {
  const props = inputProps(manifest);
  const secrets = previewSecrets(manifest);
  const state: InputFilterState = { deniedKeys: new Set(), restricted: false };
  const values: Record<string, Json> = {};
  const names = new Set([...Object.keys(props), ...Object.keys(source), ...Object.keys(overrides)]);
  for (const name of names) {
    const schema = Object.hasOwn(props, name) ? props[name] : undefined;
    const inSource = Object.hasOwn(source, name);
    const inOverrides = Object.hasOwn(overrides, name);
    if (!schema || isPrivateName(name) || !inputVisibleTo(name, schema, role, secrets)) {
      state.deniedKeys.add(name);
      if (inSource || inOverrides || (defaults && schema && Object.hasOwn(schema, 'default')))
        state.restricted = true;
      continue;
    }
    // Only now is it safe to dereference the sample or override.
    let value = inOverrides ? overrides[name] : inSource ? source[name] : undefined;
    if (defaults && value == null && Object.hasOwn(schema, 'default')) value = schema.default;
    const next = visibleInput(name, value, schema, role, secrets, state);
    if (next !== undefined) values[name] = next;
  }
  return { values, ...state, props, secrets };
}

export { clean, filteredInputs, obj, privateExpression };
