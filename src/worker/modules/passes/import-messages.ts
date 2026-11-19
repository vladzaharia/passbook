import type { z } from 'zod';
import {
  PASS_IMPORT_MAX_CELL,
  type PassImportProblemSchema,
} from '../../../shared/contracts/pass-imports.ts';

export type ImportProblem = z.infer<typeof PassImportProblemSchema>;

/** The one constructor of problems: column, field and message are clamped to the contract so a row's problems always parse. */
export function problem(
  row: number,
  p: Omit<ImportProblem, 'row' | 'severity' | 'column' | 'field'> &
    Partial<Pick<ImportProblem, 'column' | 'field' | 'severity'>>,
): ImportProblem {
  return {
    row,
    severity: 'error',
    ...p,
    column: p.column?.slice(0, 200) ?? null,
    field: p.field?.slice(0, 64) ?? null,
    message: p.message.slice(0, 200),
  };
}

/** One sentence per row problem. The row number rides in `ImportProblem.row`, not in the text. */
export const IMPORT_TEXT = {
  rowShape: (got: number, want: number) =>
    `The row has ${got} cells; the header has ${want}. Check for a stray delimiter.`,
  cellTooLong: (column: string) =>
    `${column} is longer than ${PASS_IMPORT_MAX_CELL} characters. Shorten it.`,
  emailInvalid: 'Email is not valid.',
  keyTooLong: (label: string) => `${label} is longer than 200 characters. Shorten it.`,
  keyTaken: (id: string) => `External ID ${id} is already used by another pass.`,
  manualReplaced: (label: string) => `${label} was edited in PassBook; the file replaces it.`,
  keyMissing: (label: string) => `${label} is empty. Fill it in.`,
  duplicateKey: (label: string, value: string | null, other: number) =>
    `${label}${value === null ? '' : ` ${value}`} is also on row ${other}.`,
  ambiguous: (label: string) => `More than one pass has this ${label}. Fix it in PassBook first.`,
  otherTemplate: 'This pass uses another template. Import it with that template.',
  connected: (name: string | null) => `Synced by ${name ?? 'a connection'}. Change it there.`,
  manualKept: (label: string) => `${label} was edited in PassBook; left as is.`,
  emailKept: 'The holder email differs; the pass keeps its own.',
  columnMissing: (column: string) => `The file has no "${column}" column.`,
} as const;

const TYPE_WORDS: Record<string, string> = {
  integer: 'must be a whole number.',
  number: 'must be a number.',
  string: 'must be text.',
  boolean: 'must be yes or no.',
  array: 'must be a list.',
  object: 'is not valid.',
};

/** Rewrites a JSON Schema failure as one sentence about the input, by keyword. */
export function inputMessage(
  issue: { keyword: string; message: string },
  label: string,
  schema: Record<string, unknown> | undefined,
): string {
  const s = schema ?? {};
  const num = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : null);
  switch (issue.keyword) {
    case 'pattern':
      return typeof s['x-pattern-message'] === 'string'
        ? s['x-pattern-message']
        : `${label} is not in the right format.`;
    case 'required':
      return `${label} is required.`;
    case 'type': {
      const want = typeof s.type === 'string' ? s.type : '';
      return `${label} ${TYPE_WORDS[want] ?? 'is not valid.'}`;
    }
    case 'minLength':
      return num('minLength') === 1
        ? `${label} is required.`
        : `${label} must have at least ${num('minLength')} characters.`;
    case 'maxLength':
      return `${label} must have at most ${num('maxLength')} characters.`;
    case 'minimum':
      return `${label} must be at least ${num('minimum')}.`;
    case 'maximum':
      return `${label} must be at most ${num('maximum')}.`;
    case 'exclusiveMinimum':
      return `${label} must be more than ${num('exclusiveMinimum')}.`;
    case 'exclusiveMaximum':
      return `${label} must be less than ${num('exclusiveMaximum')}.`;
    case 'minItems':
      return `${label} needs at least ${num('minItems')} items.`;
    case 'maxItems':
      return `${label} allows at most ${num('maxItems')} items.`;
    case 'enum': {
      const values = Array.isArray(s.enum) ? s.enum.map(String).slice(0, 8) : [];
      const last = values.pop();
      if (last === undefined) return `${label} is not valid.`;
      return `${label} must be ${values.length ? `${values.join(', ')} or ` : ''}${last}.`;
    }
    case 'format':
      return `${label} is not in the right format.`;
    default:
      return `${label} is not valid.`;
  }
}
