import type { InputMatch } from '../../../shared/contracts/broadcasts.ts';
import { addDays, startOfDay } from '../../../shared/zoned.ts';
import { eventMatchSql } from '../scan/repo-event-match.ts';

type Clause = InputMatch[number];
type Sql = { sql: string; params: (string | number)[] };

/** Looks `key` up in the pass's personalization object; invalid JSON or a non-object matches nothing. */
function inputRow(passAlias: string, predicate: string): string {
  return `CASE WHEN json_valid(${passAlias}.personalization)
      AND json_type(${passAlias}.personalization)='object' THEN EXISTS (
      SELECT 1 FROM json_each(${passAlias}.personalization) i WHERE i.key = ? AND ${predicate}
    ) ELSE 0 END`;
}

function clauseSql(clause: Clause, passAlias: string): Sql {
  if ('values' in clause) {
    // The scan-event predicate itself, fed one derived event row: the semantics cannot drift.
    return {
      sql: `EXISTS (SELECT 1 FROM (SELECT ? AS match_input, ? AS match_values) m
        WHERE ${eventMatchSql('m', passAlias)})`,
      params: [clause.input, JSON.stringify(clause.values)],
    };
  }
  const params: (string | number)[] = [clause.input];
  if ('timeZone' in clause) {
    const { from, to, timeZone } = clause;
    const dateOnly: string[] = ['length(i.value) = 10'];
    const dateTime: string[] = ['length(i.value) > 10'];
    const dateParams: string[] = [];
    const timeParams: number[] = [];
    if (from) {
      dateOnly.push('i.value >= ?');
      dateParams.push(from);
      dateTime.push('unixepoch(i.value) * 1000 >= ?');
      timeParams.push(startOfDay(from, timeZone));
    }
    if (to) {
      dateOnly.push('i.value <= ?');
      dateParams.push(to);
      dateTime.push('unixepoch(i.value) * 1000 < ?');
      timeParams.push(startOfDay(addDays(to, 1), timeZone));
    }
    return {
      sql: inputRow(
        passAlias,
        `i.type = 'text' AND ((${dateOnly.join(' AND ')}) OR (${dateTime.join(' AND ')}))`,
      ),
      params: [...params, ...dateParams, ...timeParams],
    };
  }
  const bounds: string[] = [];
  if (clause.min !== undefined) {
    bounds.push('i.value >= ?');
    params.push(clause.min);
  }
  if (clause.max !== undefined) {
    bounds.push('i.value <= ?');
    params.push(clause.max);
  }
  return {
    sql: inputRow(passAlias, `i.type IN ('integer','real') AND ${bounds.join(' AND ')}`),
    params,
  };
}

/** ANDed clauses over a pass's inputs. All user text is bound, never interpolated. */
export function inputMatchSql(match: InputMatch, passAlias: string): Sql {
  const parts = match.map((clause) => clauseSql(clause, passAlias));
  return {
    sql: parts.map((p) => `(${p.sql})`).join(' AND '),
    params: parts.flatMap((p) => p.params),
  };
}
