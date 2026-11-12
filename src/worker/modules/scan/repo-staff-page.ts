import { containsMatch, type SqlMatch } from '../../platform/db.ts';
import { ValidationError } from '../../platform/errors.ts';

/** The last person of a page: active people first, then name (case-insensitive), then id. */
interface StaffCursor {
  disabled: boolean;
  name: string;
  id: string;
}

/** Bounded, searchable, cursor-paged list: the page holds at most `limit` people. */
export interface StaffPage {
  q?: string | undefined;
  limit: number;
  staffId?: string | undefined;
  cursor?: StaffCursor | undefined;
}
export const STAFF_PAGE_LIMIT = 50;
export const STAFF_PAGE_MAX = 200;
/** The name search for the staff alias `st`: any part of the name, case-insensitive for ASCII. */
export const staffNameMatch = (q: string | undefined): SqlMatch =>
  q ? containsMatch('st.name', q) : { sql: '1', params: [] };

export const encodeStaffCursor = (p: { disabledAt: number | null; name: string; id: string }) =>
  btoa(JSON.stringify([p.disabledAt !== null ? 1 : 0, p.name, p.id]))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

export function decodeStaffCursor(raw: string | undefined): StaffCursor | undefined {
  if (!raw) return undefined;
  try {
    const [d, name, id] = JSON.parse(
      atob(raw.replaceAll('-', '+').replaceAll('_', '/')),
    ) as unknown[];
    if ((d === 0 || d === 1) && typeof name === 'string' && typeof id === 'string')
      return { disabled: d === 1, name, id };
  } catch {
    // Falls through to the refusal below.
  }
  throw new ValidationError(
    'That page is no longer valid. Reload the list.',
    [],
    'SCAN_STAFF_CURSOR',
  );
}

/** Rows after the cursor in the list's order, for the staff alias `st`. Six binds. */
export function afterCursorSql(cursor: StaffCursor | undefined) {
  return {
    sql: `AND (? IS NULL OR (st.disabled_at IS NOT NULL) > ? OR ((st.disabled_at IS NOT NULL) = ?
      AND (st.name COLLATE NOCASE > ? OR (st.name COLLATE NOCASE = ? AND st.id > ?))))`,
    params: cursor
      ? [1, +cursor.disabled, +cursor.disabled, cursor.name, cursor.name, cursor.id]
      : [null, 0, 0, '', '', ''],
  };
}
