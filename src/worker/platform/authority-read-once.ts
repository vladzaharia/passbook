import { AuthorityError } from './authority-error.ts';

const ACTOR_NAME = /^(?:actor_ok|actor|key_tpl)$/i;

/**
 * One left-to-right pass, so a quote inside a comment, or a comment marker inside a string, cannot hide text.
 * Comments vanish, string literals are blanked, and quoted identifiers are unquoted: SQLite reads `"actor_ok"`,
 * `[actor_ok]` and backticks as the name, and a bare `'actor_ok'` as a table name too, so that one stays visible.
 */
const scrub = (sql: string): string =>
  sql.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'((?:[^']|'')*)'|"((?:[^"]|"")*)"|\[([^\]]*)\]|`((?:[^`]|``)*)`/g,
    (m, sq?: string, dq?: string, br?: string, bt?: string) => {
      if (m.startsWith('--') || m.startsWith('/*')) return ' ';
      if (sq !== undefined) return ACTOR_NAME.test(sq) ? ` ${sq} ` : "''";
      return ` ${dq ?? br ?? bt ?? ''} `;
    },
  );

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

/**
 * A read statement expands the actor once (workerd's SQLite counts every CTE reference's cursors against its
 * limit): `actor_ok` appears as one FROM or JOIN term outside its own definition, `actor` only inside that
 * definition, and `key_tpl` nowhere. Names match case-insensitively, quoted or not; a comma join, an IN list
 * or a subquery counts as a second reference. A single reference in a nested FROM passes (one expansion).
 * The alias `ao` belongs to `actor_ok`, and `ao.org_id IS NULL` is allowed only after `ao.present = 1`
 * (use `platform`): an absent anchor row is NULL too. Dotted names (`a.actor_ok`) are columns. Throws
 * `SQL_ACTOR_REUSE`. A column alias `AS actor` trips it too: it fails closed.
 */
export function assertActorOnce(sql: string): void {
  // `AS actor_ok` is the actor row's own column alias, not a reference to the CTE.
  const text = scrub(sql).replace(/\bAS\s+actor_ok(?![\w])/gi, 'AS col');
  const name = (n: string) => new RegExp(`(?<![.\\w])${n}(?![\\w])`, 'gi');
  const defined = (n: string) =>
    count(text, new RegExp(`(?<![.\\w])${n}\\s+AS\\s+(?:NOT\\s+)?(?:MATERIALIZED\\s*)?\\(`, 'gi'));
  const usedFrom = count(text, /\b(?:FROM|JOIN)\s+actor_ok(?![\w])/gi);
  // Structural: an `ao.org_id` outside `= ao.org_id` / `ao.org_id =` (NULL-safe equality) needs `ao.present = 1`
  // in the statement, whatever the spelling (ISNULL, COALESCE, IS NOT NOT NULL ...).
  const bareNull =
    /\bao\.org_id\b/i.test(text.replace(/(?:=|\|\|)\s*ao\.org_id\b|\bao\.org_id\s*=(?!=)/gi, '')) &&
    !/\bao\.present\s*=\s*1\b/i.test(text);
  const aliases = [...text.matchAll(/(?<![.\w])([A-Za-z_]\w*|\))\s+(?:AS\s+)?ao(?![\w.])/gi)];
  const shadowed = aliases.some((m) => m[1]?.toLowerCase() !== 'actor_ok');
  const bad =
    defined('actor_ok') !== 1 ||
    defined('actor') !== 1 ||
    usedFrom !== 1 ||
    count(text, name('actor_ok')) !== 2 ||
    count(text, name('actor')) !== 2 ||
    count(text, name('key_tpl')) !== 0 ||
    bareNull ||
    shadowed;
  if (bad)
    throw new AuthorityError(
      'SQL_ACTOR_REUSE',
      'A read statement joins actor_ok once, as ao, and references no other actor CTE; any other use of ao.org_id needs ao.present = 1.',
    );
}
