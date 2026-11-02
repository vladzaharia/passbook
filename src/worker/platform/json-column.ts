import { createLogger, type Logger } from './log.ts';

const defaultLog = createLogger();

/**
 * Parses a TEXT column holding a JSON array and keeps the items `accept` approves. Corrupt
 * input yields an empty list and a `json_column.corrupt` log with the column name, never the value.
 */
export function parseJsonArray<T>(
  raw: string,
  column: string,
  accept: (item: unknown) => item is T,
  log: Logger = defaultLog,
): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn('json_column.corrupt', { column, code: 'JSON_COLUMN_CORRUPT' });
    return [];
  }
  if (!Array.isArray(parsed)) {
    log.warn('json_column.corrupt', { column, code: 'JSON_COLUMN_CORRUPT' });
    return [];
  }
  return parsed.filter(accept);
}

export type StoredRole = 'admin' | 'user';

export const parseRoles = (raw: string, log?: Logger): StoredRole[] =>
  parseJsonArray(raw, 'roles', (r): r is StoredRole => r === 'admin' || r === 'user', log);
