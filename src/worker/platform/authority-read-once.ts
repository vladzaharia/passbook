import { AuthorityError } from './authority-error.ts';
import { ANCHOR, ROWS, ROWS_ALONE } from './authority-read.ts';
import { assertAnchorOperands, assertAnchorShape, TERM } from './authority-read-shape.ts';

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

const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

/**
 * A read statement expands the actor once (workerd's SQLite counts every CTE reference's cursors against its
 * limit): `actor_ok` appears as one FROM or JOIN term outside its own definition, `actor` only inside that
 * definition, and `key_tpl` nowhere. Names match case-insensitively, quoted or not; a comma join, an IN list
 * or a subquery counts as a second reference. A single reference in a nested FROM passes (one expansion).
 * The alias `ao` belongs to `actor_ok`, and `ao.org_id` is allowed only as `= ao.org_id`, `ao.org_id =` or
 * the `platform` text: an absent anchor row is NULL too. Dotted names (`a.actor_ok`) are columns. Throws
 * `SQL_ACTOR_REUSE`. A column alias `AS actor` trips it too: it fails closed.
 */
export function assertActorOnce(sql: string): void {
  // The builder's exact texts become one placeholder before anything else (and before `scrub`, which blanks the
  // sentinel's hex literal): any other spelling of `actor_ok ao` stays visible and is counted below.
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  const exact = (t: string) => esc(flat(t).trim());
  const blanked = flat(sql)
    .replace(new RegExp(exact(ANCHOR), 'g'), ` ${TERM} `)
    .replace(new RegExp(`(?<![.\\w])${exact(ROWS)}`, 'g'), ` ${TERM} CROSS JOIN `)
    .replace(
      new RegExp(`\\bFROM ${exact(ROWS_ALONE)}(?= WHERE\\b|\\s*\\)|\\s*$)`, 'g'),
      ` FROM ${TERM}`,
    );
  // `AS actor_ok` is the actor row's own column alias, not a reference to the CTE.
  const shape = scrub(blanked);
  const text = shape.replace(/\bAS\s+actor_ok(?![\w])/gi, 'AS col');
  const name = (n: string) => new RegExp(`(?<![.\\w])${n}(?![\\w])`, 'gi');
  const defined = (n: string) =>
    count(text, new RegExp(`(?<![.\\w])${n}\\s+AS\\s+(?:NOT\\s+)?(?:MATERIALIZED\\s*)?\\(`, 'gi'));
  // `ao.org_id` appears only in `= ao.org_id`, `ao.org_id =` (NULL-safe equality), `ao.org_id IS NULL` (the `platform`
  // text) or `||`; any other spelling (ISNULL, COALESCE, parentheses ...) is refused.
  const bareNull = /\bao\.org_id\b/i.test(
    text
      .replace(/\bao\.org_id\s+IS\s+NULL\b/gi, ' ')
      .replace(/(?:(?<![!<>])=|\|\|)\s*ao\.org_id\b|\bao\.org_id\s*=(?!=)/gi, ' '),
  );
  // A comparison absorbed by a function (`IFNULL(ao.org_id = x, 1)`) is true on an absent anchor row.
  const wrapped =
    /\b(?:IFNULL|COALESCE|NULLIF|IIF|MAX|MIN|TOTAL|SUM|COUNT)\s*\([^)]*\bao\.(?:org_id|mode|limit_key)\b/i.test(
      text,
    ) || /\bNOT\s*\(\s*ao\.authority_present_k7\b/i.test(text);
  const aliases = [...text.matchAll(/(?<![.\w])([A-Za-z_]\w*|\))\s+(?:AS\s+)?ao(?![\w.])/gi)];
  const shadowed = aliases.some((m) => m[1]?.toLowerCase() !== 'ao_term');
  const bad =
    defined('actor_ok') !== 1 ||
    defined('actor') !== 1 ||
    count(text, name('actor_ok')) !== 1 ||
    count(text, name('ao_term')) !== 1 ||
    count(text, name('actor')) !== 2 ||
    count(text, name('key_tpl')) !== 0 ||
    bareNull ||
    wrapped ||
    shadowed;
  if (bad)
    throw new AuthorityError(
      'SQL_ACTOR_REUSE',
      "A read statement joins actor_ok once, as ao, through the builder's own FROM text, and references no other actor CTE; the presence column is read only as WHERE/ON <P> = 1 or through authorized().",
    );
  assertAnchorShape(shape);
  assertAnchorOperands(shape);
}
