import { AuthorityError } from './authority-error.ts';

/** Quoted text and comments never name a table: blank them so a literal cannot hide or fake a reference. */
const stripLiterals = (sql: string): string =>
  sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

/**
 * A read statement expands the actor once (workerd's SQLite counts every CTE reference's cursors against its
 * limit): `actor_ok` appears as one FROM or JOIN term outside its own definition, `actor` only inside that
 * definition, and `key_tpl` nowhere. Throws `SQL_ACTOR_REUSE` otherwise. Dotted names (`a.actor_ok`) are columns.
 */
export function assertActorOnce(sql: string): void {
  // `AS actor_ok` is the actor row's own column alias, not a reference to the CTE.
  const text = stripLiterals(sql).replace(/\bAS\s+actor_ok(?![\w])/gi, 'AS col');
  const name = (n: string) => new RegExp(`(?<![.\\w])${n}(?![\\w])`, 'g');
  const defined = (n: string) =>
    count(text, new RegExp(`(?<![.\\w])${n}\\s+AS\\s+(?:NOT\\s+)?(?:MATERIALIZED\\s*)?\\(`, 'gi'));
  const usedFrom = count(text, /\b(?:FROM|JOIN)\s+actor_ok(?![\w])/gi);
  const bad =
    defined('actor_ok') !== 1 ||
    defined('actor') !== 1 ||
    usedFrom !== 1 ||
    count(text, name('actor_ok')) !== 2 ||
    count(text, name('actor')) !== 2 ||
    count(text, name('key_tpl')) !== 0;
  if (bad)
    throw new AuthorityError(
      'SQL_ACTOR_REUSE',
      'A read statement joins actor_ok once, in its outermost FROM, and references no other actor CTE.',
    );
}
