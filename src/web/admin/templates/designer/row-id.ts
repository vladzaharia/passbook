/**
 * A data-row-id that is a valid CSS custom-ident: removeWithTransition turns it into a
 * view-transition-name, and an invalid one makes the whole page blink instead of the row leaving.
 * Characters outside [A-Za-z0-9_] become `-<hex>`, so two keys never share an id.
 */
export function rowId(kind: 'field' | 'input', key: string): string {
  let out = '';
  for (const ch of key) {
    out += /[A-Za-z0-9_]/.test(ch) ? ch : `-${ch.codePointAt(0)?.toString(16)}-`;
  }
  return `${kind}-${out}`;
}
