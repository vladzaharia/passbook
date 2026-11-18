import { conditionInputs, exprReferences } from '../../../passkit/template/expr.ts';
import type { Json, TemplateManifest } from '../../../passkit/types.ts';
import type { JoinReadinessIssue } from '../../../shared/contracts/join.ts';

export interface JoinInputRef {
  key: string;
  label: string;
}

export interface JoinReadiness {
  issues: JoinReadinessIssue[];
  /** Inputs the holder may fill with their name. */
  nameInputs: JoinInputRef[];
  /** Required inputs nobody asks for: each gets a generated 10-digit value. */
  generated: JoinInputRef[];
  /** The input the link asks the name for (the stored choice when eligible). */
  nameInput: string | null;
}

type Rec = Record<string, Json>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A name input holds at least this many characters (the form caps a name at 40). */
const NAME_MIN_LENGTH = 20;
const GENERATED_DIGITS = 10;
const SAMPLE_CODE = '1234567890';
/** The only barcode a public card may carry: the server's scan code. */
const SCAN_CODE_EXPR = '{{pass.scanCode}}';

const labelOf = (key: string, schema: Rec): string => {
  const label = schema['x-label'] ?? schema.title;
  return typeof label === 'string' && label.trim() !== '' ? label : key;
};

const orderOf = (schema: Rec): number =>
  typeof schema['x-order'] === 'number' ? schema['x-order'] : Number.MAX_SAFE_INTEGER;

/** Inputs the barcode, lookup, stamps, messaging and scan blocks read: operator-owned, never the holder's. */
export function reservedInputs(manifest: TemplateManifest): Set<string> {
  const names = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value !== '') names.add(value);
  };
  for (const binding of manifest.bindings ?? []) {
    if (!('barcode' in binding.to)) continue;
    for (const name of exprReferences(binding.value ?? '').inputs) names.add(name);
    for (const condition of [binding.when, binding.remove])
      if (condition) for (const name of conditionInputs(condition)) names.add(name);
  }
  add(manifest.scan?.lookup?.input);
  add(manifest.stamps?.input);
  add(manifest.messaging?.input);
  for (const action of manifest.scan?.actions ?? []) add(action.input);
  for (const flag of manifest.scan?.flags ?? []) add(flag.input);
  add(manifest.scan?.window?.from);
  add(manifest.scan?.window?.until);
  return names;
}

function nameEligible(schema: Rec): boolean {
  if (schema.type !== 'string') return false;
  for (const keyword of ['format', 'pattern', 'enum', 'const'])
    if (schema[keyword] !== undefined) return false;
  const max = schema.maxLength;
  return max === undefined || (typeof max === 'number' && max >= NAME_MIN_LENGTH);
}

/** A required string a 10-digit number satisfies. */
function generatable(schema: Rec): boolean {
  if (schema.type !== 'string') return false;
  for (const keyword of ['format', 'enum', 'const'])
    if (schema[keyword] !== undefined) return false;
  const { minLength, maxLength, pattern } = schema;
  if (minLength !== undefined && !(typeof minLength === 'number' && minLength <= GENERATED_DIGITS))
    return false;
  if (maxLength !== undefined && !(typeof maxLength === 'number' && maxLength >= GENERATED_DIGITS))
    return false;
  if (pattern === undefined) return true;
  try {
    return typeof pattern === 'string' && new RegExp(pattern, 'u').test(SAMPLE_CODE);
  } catch {
    return false;
  }
}

/** The first of these: no message binding at all, a conditional one, or one that is not the scan code. */
function barcodeIssue(
  manifest: TemplateManifest,
  labels: Map<string, string>,
): JoinReadinessIssue | null {
  const bindings = (manifest.bindings ?? []).filter(
    (b) => 'barcode' in b.to && (b.to.barcode === '*' || b.to.barcode === 0),
  );
  const named = (input: string): JoinReadinessIssue => ({
    code: 'barcode_input',
    input,
    label: labels.get(input) ?? input,
  });
  for (const b of bindings) {
    const inputs = [
      ...exprReferences(b.value ?? '').inputs,
      ...[b.when, b.remove].flatMap((c) => (c ? conditionInputs(c) : [])),
    ];
    const first = inputs[0];
    if (first !== undefined) return named(first);
  }
  const messages = bindings.filter((b) => 'prop' in b.to && b.to.prop === 'message');
  const last = messages.at(-1);
  const plain =
    last !== undefined &&
    messages.every((b) => b.when === undefined && b.remove === undefined) &&
    typeof last.value === 'string' &&
    last.value.trim() === SCAN_CODE_EXPR;
  return plain ? null : { code: 'barcode_input' };
}

/**
 * Whether a release's manifest can take public sign-ups, and what the form asks. Pure over the manifest:
 * the barcode must be the scan code, and every required input with no default is either the name the
 * holder types or a value the server makes up.
 */
export function joinReadiness(
  manifest: TemplateManifest,
  chosenName: string | null,
): JoinReadiness {
  const properties = isRecord(manifest.inputs.properties) ? manifest.inputs.properties : {};
  const required = new Set(manifest.inputs.required ?? []);
  const reserved = reservedInputs(manifest);
  const entries = Object.entries(properties)
    .flatMap(([key, schema]) => (isRecord(schema) ? [[key, schema] as const] : []))
    .sort((a, b) => orderOf(a[1]) - orderOf(b[1]) || a[0].localeCompare(b[0]));
  const labels = new Map(entries.map(([key, schema]) => [key, labelOf(key, schema)]));
  const nameInputs = entries
    .filter(([key, schema]) => !reserved.has(key) && nameEligible(schema))
    .map(([key]) => ({ key, label: labels.get(key) ?? key }));
  const nameInput = nameInputs.some((i) => i.key === chosenName) ? chosenName : null;
  const issues: JoinReadinessIssue[] = [];
  const barcode = barcodeIssue(manifest, labels);
  if (barcode) issues.push(barcode);
  const generated: JoinInputRef[] = [];
  for (const [key, schema] of entries) {
    if (!required.has(key) || schema.default !== undefined || key === nameInput) continue;
    if (generatable(schema)) generated.push({ key, label: labels.get(key) ?? key });
    else issues.push({ code: 'input_needed', input: key, label: labels.get(key) ?? key });
  }
  return { issues, nameInputs, generated, nameInput };
}

/** The input a new link asks the name for: the first eligible input in the Holder group, else the first eligible. */
export function defaultNameInput(manifest: TemplateManifest): string | null {
  const { nameInputs } = joinReadiness(manifest, null);
  const properties = isRecord(manifest.inputs.properties) ? manifest.inputs.properties : {};
  const holder = nameInputs.find((i) => {
    const schema = properties[i.key];
    return isRecord(schema) && schema['x-group'] === 'Holder';
  });
  return (holder ?? nameInputs[0])?.key ?? null;
}
