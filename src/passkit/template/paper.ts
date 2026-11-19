/**
 * The optional `paper` block of `wallet.template.json` (delivery channels design, section 4): how a
 * printed ticket looks. Versioned design, strict zod. Absent means "derived": the layout reads the
 * shared pass-view roles (paper-content.ts). Paper never prints the scan lookup field or the scan
 * code; the door credential on paper is the print code.
 */
import { z } from 'zod';
import type { Expr, TemplateManifest, ValidationIssue } from '../types.ts';
import { checkExpr, exprReferences } from './expr.ts';

export const PAPER_SCHEMA = 1;
export const PAPER_SIZES = ['a4', 'letter', 'half', 'cr80'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];
export const PAPER_BARCODES = ['qr', 'code128'] as const;
export type PaperBarcode = (typeof PAPER_BARCODES)[number];

export interface PaperSpec {
  label: string;
  widthMm: number;
  heightMm: number;
  /** The QR symbol's side, without its quiet zone. At least 30 mm everywhere. */
  qrMm: number;
  /** Code 128 width in mm, with 0.2 mm or wider bars. */
  barMm: number;
}

/** Page sizes in mm. `half` is a half sheet, landscape; `cr80` is a card. */
export const PAPER_SPECS: Record<PaperSize, PaperSpec> = {
  a4: { label: 'A4', widthMm: 210, heightMm: 297, qrMm: 45, barMm: 100 },
  letter: { label: 'Letter', widthMm: 215.9, heightMm: 279.4, qrMm: 45, barMm: 100 },
  half: { label: 'Half sheet', widthMm: 210, heightMm: 148, qrMm: 38, barMm: 90 },
  cr80: { label: 'Card', widthMm: 85.6, heightMm: 54, qrMm: 30, barMm: 66 },
};

export const MAX_PAPER_FIELDS = 8;
const MAX_PAPER_EXPR = 1000;
/** A field by key (`seat`) or by path (`backFields.terms`). */
const FIELD_REF = /^[A-Za-z][A-Za-z0-9_.-]*$/;

const unique = (list: string[]) => new Set(list).size === list.length;
const expr = z.union([z.string().min(1).max(MAX_PAPER_EXPR), z.strictObject({ const: z.json() })]);

export const PaperManifestSchema = z.strictObject({
  schema: z.literal(PAPER_SCHEMA),
  size: z.enum(PAPER_SIZES),
  barcode: z.enum(PAPER_BARCODES),
  fields: z
    .array(z.string().min(1).max(64).regex(FIELD_REF))
    .max(MAX_PAPER_FIELDS)
    .refine(unique, 'duplicate')
    .optional(),
  terms: expr.optional(),
  /** `false`: staff print only; the holder's link offers no print. */
  holder: z.boolean().optional(),
});
export type PaperManifest = z.infer<typeof PaperManifestSchema>;

/** What the print page draws: the block with its defaults filled in. */
export interface PaperDesign {
  size: PaperSize;
  barcode: PaperBarcode;
  fields: string[];
  terms?: Expr;
  holder: boolean;
  /** No block in the manifest: the layout comes from the roles. */
  derived: boolean;
}

export const DERIVED_PAPER: PaperDesign = {
  size: 'a4',
  barcode: 'qr',
  fields: [],
  holder: true,
  derived: true,
};

/** The design for a manifest's `paper` value. An invalid block falls back to derived. */
export function resolvePaper(raw: unknown): PaperDesign {
  if (raw === undefined || raw === null) return DERIVED_PAPER;
  const parsed = PaperManifestSchema.safeParse(raw);
  if (!parsed.success) return DERIVED_PAPER;
  const { size, barcode, fields, terms, holder } = parsed.data;
  return {
    size,
    // A card has no room for Code 128 (a validation error); it draws QR.
    barcode: size === 'cr80' ? 'qr' : barcode,
    fields: fields ?? [],
    ...(terms === undefined ? {} : { terms }),
    holder: holder !== false,
    derived: false,
  };
}

const dotted = (path: readonly PropertyKey[]) => ['paper', ...path.map(String)].join('.');

function shapeIssues(error: z.ZodError): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const raw of error.issues) {
    let path = dotted(raw.path);
    let code = 'PAPER_SHAPE';
    let message = 'This is not a valid paper block.';
    if (raw.code === 'unrecognized_keys') {
      path = `${path}.${raw.keys[0]}`;
      code = 'PAPER_UNKNOWN_KEY';
      message = `Unknown key "${raw.keys[0]}".`;
    } else if (raw.path.length === 1 && raw.path[0] === 'schema') {
      code = 'PAPER_VERSION';
      message = 'paper.schema must be 1.';
    } else if (raw.path[0] === 'size') {
      code = 'PAPER_SIZE';
      message = `size is one of ${PAPER_SIZES.join(', ')}.`;
    } else if (raw.path[0] === 'barcode') {
      code = 'PAPER_BARCODE';
      message = 'barcode is qr or code128.';
    } else if (raw.path[0] === 'fields') {
      code = 'PAPER_FIELD';
      message = `fields is a list of up to ${MAX_PAPER_FIELDS} field keys.`;
    }
    if (seen.has(`${code}|${path}`)) continue;
    seen.add(`${code}|${path}`);
    out.push({ severity: 'error', code, message, path });
  }
  return out;
}

const keyOf = (ref: string) => ref.split('.').at(-1) ?? ref;

/** Static checks for `manifest.paper`. An absent block has no issues. */
export function paperManifestIssues(
  manifest: TemplateManifest,
  options: { passJson?: unknown } = {},
): ValidationIssue[] {
  const raw: unknown = (manifest as { paper?: unknown }).paper;
  if (raw === undefined) return [];
  const parsed = PaperManifestSchema.safeParse(raw);
  if (!parsed.success) return shapeIssues(parsed.error);

  const issues: ValidationIssue[] = [];
  const add =
    (severity: ValidationIssue['severity']) =>
    (code: string, message: string, path: string, params?: ValidationIssue['params']) =>
      issues.push({ severity, code, message, path, ...(params ? { params } : {}) });
  const error = add('error');
  const warn = add('warning');
  const paper = parsed.data;
  const properties = (manifest.inputs?.properties ?? {}) as Record<string, unknown>;
  const lookups = new Set(Object.keys(manifest.lookups ?? {}));
  const lookupInput = (manifest as { scan?: { lookup?: { input?: unknown } } }).scan?.lookup?.input;

  const checkExprAt = (value: Expr, path: string) => {
    const problem = checkExpr(value);
    if (problem) {
      error('PAPER_EXPR', problem, path);
      return;
    }
    if (typeof value === 'string' && /\bpass\.scanCode\b/.test(value))
      error('PAPER_SCAN_CODE', 'Paper never prints the scan code.', path);
    const refs = exprReferences(value);
    for (const name of refs.inputs) {
      if (name === lookupInput)
        error('PAPER_LOOKUP_FIELD', 'Paper never prints the scan lookup value.', path);
      else if (!Object.hasOwn(properties, name))
        warn('PAPER_INPUT', `Unknown input "${name}".`, path, { name });
    }
    for (const name of refs.lookups)
      if (!lookups.has(name)) error('PAPER_LOOKUP', `Unknown lookup table "${name}".`, path);
  };
  if (paper.terms !== undefined) checkExprAt(paper.terms, 'paper.terms');

  const known = new Set<string>();
  if (options.passJson && typeof options.passJson === 'object') {
    for (const dict of Object.values(options.passJson as Record<string, unknown>)) {
      if (!dict || typeof dict !== 'object' || Array.isArray(dict)) continue;
      for (const list of Object.values(dict as Record<string, unknown>))
        if (Array.isArray(list))
          for (const f of list) known.add(String((f as { key?: unknown } | null)?.key));
    }
  }
  const bindings = Array.isArray(manifest.bindings) ? manifest.bindings : [];
  for (const [i, ref] of (paper.fields ?? []).entries()) {
    const path = `paper.fields.${i}`;
    const key = keyOf(ref);
    if (known.size > 0 && !known.has(key))
      warn('PAPER_FIELD', `No field with key "${key}".`, path, { name: key });
    for (const b of bindings) {
      const to = b.to as { field?: unknown };
      const targets = Array.isArray(to?.field) ? to.field : [to?.field];
      if (!targets.includes(key) || b.value === undefined) continue;
      if (typeof b.value === 'string' && /\bpass\.scanCode\b/.test(b.value))
        error('PAPER_SCAN_CODE', 'This field carries the scan code.', path);
      if (typeof lookupInput === 'string' && exprReferences(b.value).inputs.includes(lookupInput))
        error('PAPER_LOOKUP_FIELD', 'This field carries the scan lookup value.', path);
    }
  }
  if (paper.size === 'cr80' && paper.barcode === 'code128')
    error('PAPER_BARCODE', 'Code 128 does not fit a card. Use QR.', 'paper.barcode');
  return issues;
}
