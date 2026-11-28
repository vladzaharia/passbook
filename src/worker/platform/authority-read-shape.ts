import { AuthorityError } from './authority-error.ts';

/**
 * Structure of a read statement around the one `ao` term (`assertActorOnce` blanks the builder's exact texts to
 * `TERM` first). Rules 1 to 3 are structural; the `ao.org_id` operand lint is not, so the sentinel and the
 * present-actor oracles are the fence for what it cannot see.
 *
 * - The `ao` core is the top-level core, or a top-level CTE (no column list) that the top-level core reads once by FROM.
 *   Never inside EXISTS, IN, a scalar subquery, a FROM sub-select or a nested CTE: those can negate presence.
 * - Each stamp (presence column) is `WHERE|ON <P> = 1` followed by AND or the clause end, or the `authorized()` output
 *   form. The `authorized()` alias appears once, in the top-level select list, unrenamed.
 * - The core is sealed: no `*` or `ao.*`, no unqualified anchor column, not an arm of a compound select.
 */
export const TERM = 'ao_term ao';
const STAMP = 'authority_present_k7';
const NULL_EXTENDS = /\b(?:RIGHT|FULL|NATURAL)\b(?!\s*\()/i;
const OUTER_BEFORE =
  /\b(?:(?:LEFT|RIGHT|FULL|NATURAL)\s+)+(?:OUTER\s+)?JOIN\s*$|\bOUTER\s+JOIN\s*$/i;
const ANCHOR_COLS = /(?<![.\w])(?:org_id|mode|limit_key|authority_present_k7)(?![\w])/gi;
const KEYWORDS =
  /^(?:LEFT|RIGHT|INNER|OUTER|CROSS|NATURAL|JOIN|WHERE|GROUP|ORDER|LIMIT|ON|UNION|INTERSECT|EXCEPT|USING|WINDOW|HAVING)$/i;

interface Core {
  id: number;
  parent: Core | null;
  /** `cte` is a top-level CTE body without a column list; `cols` has one; `nested` is anything inside a statement. */
  kind: 'root' | 'cte' | 'cols' | 'nested';
  name: string;
  text: string;
}

const refuse = (why: string): never => {
  throw new AuthorityError(
    'SQL_ACTOR_REUSE',
    `A read statement's actor term is misplaced: ${why}.`,
  );
};

/** Split at parentheses: each `(SELECT` or `(WITH` group is a core, masked in its parent as ` #n `. */
function splitCores(text: string): Core[] {
  const root: Core = { id: 0, parent: null, kind: 'root', name: '', text: '' };
  const cores = [root];
  const stack: Array<{ core: Core; owner: Core }> = [{ core: root, owner: root }];
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    const top = stack[stack.length - 1] as (typeof stack)[number];
    if (c === '(') {
      if (/^\s*(?:SELECT|WITH)\b/i.test(text.slice(i + 1, i + 12))) {
        const cte = /(?<![)\w])(\w+)\s+AS\s+(?:NOT\s+)?(?:MATERIALIZED\s*)?$/i.exec(top.core.text);
        const cols = /\)\s*AS\s+(?:NOT\s+)?(?:MATERIALIZED\s*)?$/i.test(top.core.text);
        const kind = top.core.kind !== 'root' ? 'nested' : cte ? 'cte' : cols ? 'cols' : 'nested';
        const core: Core = {
          id: cores.length,
          parent: top.core,
          kind,
          name: kind === 'cte' ? (cte?.[1] ?? '') : '',
          text: '',
        };
        cores.push(core);
        stack.push({ core, owner: core });
      } else {
        top.core.text += c;
        stack.push({ core: top.core, owner: top.core });
      }
    } else if (c === ')' && stack.length > 1) {
      const done = stack.pop() as (typeof stack)[number];
      const parent = (stack[stack.length - 1] as (typeof stack)[number]).core;
      if (done.core === done.owner && done.core !== parent) parent.text += ` #${done.core.id} `;
      else parent.text += c;
    } else top.core.text += c;
  }
  return cores;
}

/** The select list of a core: from its first SELECT to the first FROM at depth 0. */
function selectList(core: Core): { start: number; end: number } {
  const s = /\bSELECT\b/i.exec(core.text);
  if (!s) return { start: 0, end: 0 };
  const from = /\bFROM\b/i.exec(core.text.slice(s.index));
  return { start: s.index, end: from ? s.index + from.index : core.text.length };
}

const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `CASE WHEN <P> = 1 [AND ...] THEN 1 ELSE 0 END AS alias`, with `(` before `<P>` being only `CASE WHEN `. */
function outputForm(text: string, at: number): { alias: string; end: number } | null {
  if (!/CASE WHEN $/i.test(text.slice(Math.max(0, at - 13), at - 3))) return null;
  let depth = 0;
  for (let i = at + STAMP.length; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /^\sTHEN\s/i.test(text.slice(i, i + 6))) {
      const between = text.slice(at + STAMP.length, i);
      let flat = between;
      for (let prev = ''; prev !== flat; ) {
        prev = flat;
        flat = flat.replace(/\([^()]*\)/g, ' ');
      }
      if (!/^ = 1(?: AND [\s\S]*)?$/.test(between) || /\b(?:OR|NOT)\b|[<>!=]/.test(flat.slice(4)))
        return null;
      const m = /^\sTHEN 1 ELSE 0 END AS (\w+)\s*(?:,|\bFROM\b|$)/i.exec(text.slice(i));
      return m ? { alias: m[1] as string, end: i } : null;
    } else if (depth < 0) return null;
  }
  return null;
}

/** Throws `SQL_ACTOR_REUSE` unless the blanked statement places its one `ao` term and stamps as above. */
export function assertAnchorShape(blanked: string): void {
  const cores = splitCores(blanked);
  const holder = cores.filter((c) => c.text.includes(TERM));
  if (holder.length !== 1) refuse('one core holds it');
  const core = holder[0] as Core;
  const root = cores[0] as Core;
  if (core.kind === 'nested') refuse('not in a subquery, FROM sub-select or nested CTE');
  if (core.kind === 'cols') refuse('not in a CTE with a column list');
  // Stamps: only in the holder, in form (a) or (b).
  for (const c of cores)
    if (c !== core && c.name.toLowerCase() !== 'actor_ok' && new RegExp(STAMP, 'i').test(c.text))
      refuse('presence outside the ao core');
  const aliases: string[] = [];
  for (const m of core.text.matchAll(new RegExp(`(?<![.\\w])ao\\.${STAMP}`, 'gi'))) {
    const at = (m.index ?? 0) + 3;
    const before = core.text.slice(0, m.index ?? 0);
    const out = outputForm(core.text, at);
    if (out) {
      aliases.push(out.alias);
      continue;
    }
    const after = core.text.slice(at + STAMP.length);
    const clause = /(?:\bWHERE|\bON)\s+$/i.test(before);
    const ends = /^ = 1(?: AND |\s*$|\s+(?:GROUP|ORDER|LIMIT)\b)/i.test(after);
    if (!clause || !ends) refuse('presence is WHERE/ON <P> = 1 or authorized()');
  }
  if (
    /\bao\.(?!org_id\b|mode\b|limit_key\b|authority_present_k7\b)/i.test(
      core.text.replace(TERM, ''),
    )
  )
    refuse('ao has only its anchor columns');
  // Sealed core.
  const list = core.text.slice(selectList(core).start, selectList(core).end);
  if (/(?:^|,|\bSELECT\b|\bDISTINCT\b)\s*\*|\bao\.\*/i.test(list.replace(/\([^()]*\)/g, '()')))
    refuse('no * in the ao core');
  const masked = core.text.replace(
    new RegExp(`\\bao\\.(?:org_id|mode|limit_key|${STAMP})\\b`, 'gi'),
    ' ',
  );
  for (const m of masked.matchAll(ANCHOR_COLS))
    if (!/\bAS\s+$/i.test(masked.slice(0, m.index ?? 0))) refuse('no unqualified anchor column');
  if (/\b(?:UNION|INTERSECT|EXCEPT)\b/i.test(core.text)) refuse('not an arm of a compound select');
  // `ao.org_id IS NULL` reads true on a NULL-extended anchor side, so the anchor is the FROM item or inner-joined:
  // never the right side of a LEFT or OUTER join, and never on the left of a RIGHT, FULL or NATURAL join.
  for (const c of core.kind === 'cte' ? [core, root] : [core])
    if (NULL_EXTENDS.test(c.text))
      refuse('the anchor and its reader never RIGHT, FULL or NATURAL join');
  for (const m of core.text.matchAll(new RegExp(`${esc(TERM)}`, 'g')))
    if (OUTER_BEFORE.test(core.text.slice(0, m.index ?? 0)))
      refuse('the anchor is never the outer side of a LEFT join');
  assertFilters(core, aliases.length === 0);
  if (core.kind === 'cte') assertFilters(root, false);
  if (core.kind === 'cte') {
    const q = readOnceBy(root, core, cores);
    for (const alias of aliases) aliasOnlyOut(root, q, alias, cores);
    qualifiedOnlyOut(root, q, cores);
  } else for (const alias of aliases) aliasOnlyOut(root, null, alias, cores);
}

const NON_ANCHOR = String.raw`(?<![\w.])\+?(?!ao\.)[\w.?]+`;
const GATE = new RegExp(
  String.raw`\bao\.authority_present_k7\s*=\s*1\b|\bao\.org_id\s+IS\s+NULL\b|${NON_ANCHOR}\s*=\s*(?:''\s*\|\|\s*)?ao\.org_id\b|\bao\.org_id\s*=\s*\+?(?!ao\.)[\w.?]+`,
  'i',
);

/**
 * WHERE, ON and HAVING of the holder (and of the root that reads a holder CTE) are one AND chain: an OR at paren depth 0
 * lets the other arm pass for an absent actor. The holder core (unless it only outputs `authorized()`) needs a gate as
 * a depth-0 term of its WHERE or of an inner join's ON: `ao.authority_present_k7 = 1`, `ao.org_id IS NULL` (the platform term) or `<non-anchor col> = ao.org_id`.
 * `ao.* = ao.*` is no gate: an absent actor's anchor columns all hold the same sentinel.
 */
function assertFilters(core: Core, mustGate: boolean): void {
  const text = core.text;
  const tokens =
    /\b(WHERE|ON|HAVING|JOIN|GROUP|ORDER|LIMIT|FROM|WINDOW|SELECT|UNION|INTERSECT|EXCEPT|OR)\b|[()]/gi;
  const opens: number[] = [];
  const clauses: { text: string; gating: boolean; or: boolean }[] = [];
  let depth = 0;
  let cur: (typeof clauses)[number] | null = null;
  let last = 0;
  let outerJoin = false;
  for (const m of text.matchAll(tokens)) {
    const at = m.index ?? 0;
    if (depth === 0 && cur) cur.text += text.slice(last, at);
    last = at + m[0].length;
    if (m[0] === '(') {
      opens.push(at);
      depth++;
    } else if (m[0] === ')') {
      const from = opens.pop() ?? 0;
      const group = text.slice(from, at);
      if (cur && /\bOR\b/i.test(group) && /\bao\./i.test(group)) cur.or = true;
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      const kw = m[0].toUpperCase();
      if (kw === 'OR') {
        if (cur) refuse('no OR at the top level of WHERE, ON or HAVING beside the anchor');
      } else {
        if (kw === 'JOIN') outerJoin = OUTER_BEFORE.test(text.slice(0, at + 4));
        cur =
          kw === 'WHERE' || kw === 'ON' || kw === 'HAVING'
            ? { text: '', gating: kw === 'WHERE' || !outerJoin, or: false }
            : null;
        if (cur && kw === 'HAVING') cur.gating = false;
        if (cur) clauses.push(cur);
      }
    }
  }
  if (cur) cur.text += text.slice(last);
  const gate = clauses
    .filter((c) => c.gating)
    .map((c) => c.text)
    .join(' AND ');
  // A parenthesised OR over `ao.*` is gated by a top-level term of its own clause, or of any WHERE or inner ON.
  for (const c of clauses)
    if (c.or && !GATE.test(c.text) && !(c.gating && GATE.test(gate)))
      refuse(
        'an OR over ao columns needs the presence gate or the org comparison as a top-level AND term',
      );
  if (mustGate && !GATE.test(gate))
    refuse(
      'the anchor needs WHERE/ON ao.authority_present_k7 = 1, ao.org_id IS NULL or <non-anchor col> = ao.org_id as a top-level AND term',
    );
}

/** The top-level core reads the CTE once by FROM/JOIN and nowhere else reaches it; returns its qualifier. */
function readOnceBy(root: Core, cte: Core, cores: Core[]): string {
  const name = esc(cte.name);
  const use = new RegExp(`\\b(?:FROM|JOIN)\\s+${name}(?![\\w.])(?:\\s+(?:AS\\s+)?(\\w+))?`, 'gi');
  const reads = [...root.text.matchAll(use)];
  for (const r of reads)
    if (
      OUTER_BEFORE.test(root.text.slice(0, r.index ?? 0) + (/^\s*JOIN/i.test(r[0]) ? ' JOIN' : ''))
    )
      refuse('the ao CTE is never the outer side of a LEFT join');
  // `name.col` is a qualified column of the one read, not a second read.
  const any = new RegExp(`(?<![.\\w])${name}(?![\\w.])`, 'gi');
  const total = cores
    .filter((c) => c !== cte)
    .reduce((n, c) => n + (c.text.match(any)?.length ?? 0), 0);
  // The definition itself (`name AS`) is the one mention in the root core.
  if (reads.length !== 1 || total !== 2)
    refuse('the ao CTE is read once, by FROM, from the top-level core');
  const alias = reads[0]?.[1];
  return alias && !KEYWORDS.test(alias) ? alias : cte.name;
}

/** `<q>.<alias>` only unrenamed in the top-level select list; the bare alias only as the output name. */
function aliasOnlyOut(root: Core, q: string | null, alias: string, cores: Core[]): void {
  const bare = new RegExp(`(?<![.\\w])${esc(alias)}(?![\\w])`, 'i');
  if (q === null) {
    // The alias is the output name in the ao core, which is the top-level core.
    if ((root.text.match(new RegExp(bare, 'gi'))?.length ?? 0) !== 1)
      refuse('the authorized() alias appears once');
    for (const c of cores)
      if (c !== root && bare.test(c.text)) refuse('the authorized() alias is not reused');
    return;
  }
  const qual = new RegExp(`(?<![.\\w])${esc(q)}\\.${esc(alias)}(?![\\w])`, 'gi');
  const list = selectList(root);
  for (const c of cores)
    for (const m of c.text.matchAll(qual)) {
      const rest = c.text.slice((m.index ?? 0) + m[0].length);
      const inList = c === root && (m.index ?? 0) >= list.start && (m.index ?? 0) < list.end;
      if (!inList || !/^\s*(?:,|$|\bFROM\b)/i.test(rest))
        refuse('the authorized() alias only unrenamed in the top-level select list');
    }
  for (const c of cores)
    if (c.kind !== 'cte' && bare.test(c.text.replace(qual, ' ')))
      refuse('the authorized() alias is not reused');
}

/** `<cte>.*` only in the top-level select list. */
function qualifiedOnlyOut(root: Core, q: string, cores: Core[]): void {
  const star = new RegExp(`(?<![.\\w])${esc(q)}\\.\\*`, 'gi');
  for (const c of cores)
    for (const m of c.text.matchAll(star)) {
      const inList =
        c === root &&
        (m.index ?? 0) >= selectList(root).start &&
        (m.index ?? 0) < selectList(root).end;
      if (!inList) refuse('the CTE is selected only in the top-level select list');
    }
}

const OPERAND = String.raw`ao\.(?:org_id|mode|limit_key)`;

/** Lint: `ao` columns never reach a select list, LIKE, GLOB or a string function that drops the sentinel byte. */
export function assertAnchorOperands(blanked: string): void {
  for (const c of splitCores(blanked)) {
    const list = c.text.slice(selectList(c).start, selectList(c).end);
    if (new RegExp(`\\b${OPERAND}\\b`, 'i').test(list))
      refuse('ao columns stay out of select lists');
  }
  const bad = new RegExp(
    String.raw`\b${OPERAND}\b\s+(?:NOT\s+)?(?:LIKE|GLOB)\b|\b(?:LIKE|GLOB)\s*\(?\s*${OPERAND}\b|\b(?:substr|substring|replace|trim|ltrim|rtrim|unicode)\s*\([^)]*\b${OPERAND}\b`,
    'i',
  );
  if (bad.test(blanked)) refuse('ao columns are compared with = only');
  // Each predicate that holds an `ao` column is exactly `<operand> = ao.<c>` (either side) or `ao.org_id IS NULL`:
  // IS, IS NOT, CASE, NOT, arithmetic or a function around it can turn the sentinel's 0 into a pass.
  const operand = String.raw`\+?(?!ao\.)[\w.?]+`;
  const plain = new RegExp(
    String.raw`^\s*\(*\s*(?:${operand}\s*=\s*(?:''\s*\|\|\s*)?${OPERAND}|${OPERAND}\s*=\s*${operand}|${OPERAND}\s+IS\s+NULL)\s*\)*\s*$`,
    'i',
  );
  for (const c of splitCores(blanked))
    for (const part of c.text.split(
      /\b(?:WHERE|ON|AND|OR|FROM|JOIN|GROUP|ORDER|HAVING|LIMIT|SELECT)\b/i,
    ))
      if (new RegExp(String.raw`\b${OPERAND}\b`, 'i').test(part) && !plain.test(part))
        refuse(`ao columns appear only as <col> = ao.<c> or ao.<c> IS NULL:${part}`);
}
