type EventMatch = { input: string | null; values: string[] };

/** Parse a persisted event filter with the same bounds as the SQL predicate. */
export function eventMatch(input: string | null, raw: string | null): EventMatch | null {
  if (input === null && raw === null) return { input: null, values: [] };
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    Array.from(input).length > 64 ||
    raw === null
  )
    return null;
  try {
    const values: unknown = JSON.parse(raw);
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > 20 ||
      !values.every(
        (value) => typeof value === 'string' && value.length > 0 && Array.from(value).length <= 120,
      )
    )
      return null;
    return { input, values };
  } catch {
    return null;
  }
}

/** Event-to-pass filter; both arguments are trusted SQL aliases, not user input. */
export function eventMatchSql(eventAlias: string, passAlias: string): string {
  return `((${eventAlias}.match_input IS NULL AND ${eventAlias}.match_values IS NULL) OR
    CASE WHEN ${eventAlias}.match_input IS NOT NULL
      AND length(${eventAlias}.match_input) BETWEEN 1 AND 64
      AND json_valid(${eventAlias}.match_values) THEN
      CASE WHEN json_type(${eventAlias}.match_values)='array'
        AND json_array_length(${eventAlias}.match_values) BETWEEN 1 AND 20
        AND NOT EXISTS (
          SELECT 1 FROM json_each(${eventAlias}.match_values) allowed
          WHERE allowed.type!='text' OR length(allowed.value) NOT BETWEEN 1 AND 120
        ) AND json_valid(${passAlias}.personalization) THEN
        CASE WHEN json_type(${passAlias}.personalization)='object' THEN EXISTS (
          SELECT 1 FROM json_each(${passAlias}.personalization) input
          JOIN json_each(${eventAlias}.match_values) allowed
            ON allowed.type='text' AND CAST(input.value AS TEXT)=allowed.value
          WHERE input.key=${eventAlias}.match_input
            AND input.type IN ('text','integer','real','true','false')
        ) ELSE 0 END
      ELSE 0 END
    ELSE 0 END)`;
}
