import { errorMessage, isApiError } from '../../lib/errors.ts';

export type ServerOutcome =
  | {
      kind: 'fields';
      fields: Record<string, string>;
      /** The earliest step that owns any of the fields, or -1 when none does. */
      to: number;
      /** A field no step owns: its message goes on the form line. */
      orphan: string | undefined;
    }
  | { kind: 'message'; message: string };

/**
 * Where a server error lands: field errors go to the step that fixes them (`fieldStep`); a field
 * no step owns, or an error without fields, becomes one line of text.
 */
export function mapServerError(
  cause: unknown,
  steps: readonly { id: string; skip?: boolean | undefined }[],
  fieldStep: Partial<Record<string, string>>,
): ServerOutcome {
  if (!isApiError(cause) || Object.keys(cause.fields).length === 0) {
    return { kind: 'message', message: errorMessage(cause) };
  }
  const fields = Object.keys(cause.fields);
  const owner = (field: string) => {
    const id = fieldStep[field];
    return id ? steps.findIndex((s) => s.id === id && !s.skip) : -1;
  };
  const owners = fields.map(owner).filter((at) => at >= 0);
  const orphan = fields.find((f) => owner(f) < 0);
  return {
    kind: 'fields',
    fields: cause.fields,
    to: owners.length ? Math.min(...owners) : -1,
    orphan: orphan === undefined ? undefined : cause.fields[orphan],
  };
}
