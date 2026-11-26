import { escapeToken, unescapeToken } from '../records/fields.ts';

const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INDEX = /^(0|[1-9]\d*)$/;

const segment = (token: string): string =>
  INDEX.test(token)
    ? `[${token}]`
    : PLAIN.test(token)
      ? `.${token}`
      : `['${token.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;

/** `/data/0/first name` as `$.data[0]['first name']`. */
export function pointerToJsonPath(pointer: string): string {
  if (pointer === '') return '$';
  return `$${pointer.slice(1).split('/').map(unescapeToken).map(segment).join('')}`;
}

/** A records array as `$.data[*]`, and a field inside its records as `$.data[*].email`. */
export function recordsJsonPath(recordsPointer: string, fieldPointer = ''): string {
  const tail = fieldPointer === '' ? '' : pointerToJsonPath(fieldPointer).slice(1);
  return `${pointerToJsonPath(recordsPointer)}[*]${tail}`;
}

const STEP = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(0|[1-9]\d*)\]|\['((?:[^'\\]|\\.)*)'\]/y;

/** The inverse of `pointerToJsonPath` for plain paths (no wildcards, filters or slices); null otherwise. */
export function jsonPathToPointer(path: string): string | null {
  if (path === '$') return '';
  if (!path.startsWith('$')) return null;
  const tokens: string[] = [];
  STEP.lastIndex = 1;
  while (STEP.lastIndex < path.length) {
    const m = STEP.exec(path);
    if (!m) return null;
    tokens.push(m[1] ?? m[2] ?? (m[3] ?? '').replace(/\\(.)/g, '$1'));
  }
  return tokens.map((t) => `/${escapeToken(t)}`).join('');
}
