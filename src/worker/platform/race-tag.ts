/** Inert SQL comment on every grant insert, so a race test can find a grant's batch without matching SQL text. */
export const RACE_GRANT_INSERT = '/* race:grant */';

/** Inert SQL comment on the credential keyset initializer. */
export const RACE_KEYSET_INSERT = '/* race:keyset-insert */';

const LEADING_TAG = /^\/\* race:[a-z0-9-]+ \*\/ ?/;

/** Splits a leading inert race marker from SQL, so a lint that refuses comments can check the rest. */
export function splitRaceTag(sql: string): { tag: string; body: string } {
  const tag = LEADING_TAG.exec(sql)?.[0] ?? '';
  return { tag: tag.trim(), body: sql.slice(tag.length) };
}

/** SQL without any inert race marker, wherever it sits, for a lint that refuses comments. */
export const stripRaceTags = (sql: string): string =>
  sql.replace(/\/\* race:[a-z0-9-]+ \*\/ ?/g, '');
