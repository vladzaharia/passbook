// Fit rules: a value can be well-formed and still wrong for where it sits. A sentence written for broadcasts in a
// template issue, an error code the operation cannot carry, an hour bin out of order, a session named after a person.
// Pure: no I/O. exampleFailures (example-lint.ts) runs these over every example.
import { allowedCodes, ERROR_KEYS } from './example-fields.ts';
import { TABLES } from './example-names.ts';
import { familyOf, PROSE_KEYS, SENTENCE_HOME } from './example-text.ts';

type Json = Record<string, unknown>;
interface Example {
  where: string;
  value: unknown;
  op: string;
}

const CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
/** States that say a record finished well; an error code beside one is a contradiction. */
const SETTLED =
  /^(complete|completed|done|delivered|succeeded|sent|finished|ok|healthy|active|applied)$/;
const PEOPLE = new Set([
  ...(TABLES.person ?? []),
  ...(TABLES.holder ?? []),
  ...(TABLES.visitor ?? []),
]);
const HOUR_LABEL = /^([01]\d|2[0-3]):00$/;

/** `HH:00` of an instant in a zone; undefined for a zone Intl does not know (reported by the caller). */
function localHourOf(at: number, timeZone: string): string | undefined {
  if (!Intl.supportedValuesOf('timeZone').includes(timeZone) && timeZone !== 'UTC')
    return undefined;
  const h = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(at);
  return `${h.padStart(2, '0')}:00`;
}

/** One message per value that does not fit its place. */
export function fitFailures(doc: object, examples: Example[]): string[] {
  const out: string[] = [];
  for (const ex of examples) {
    const family = familyOf(ex.op);
    let codes: Set<string> | undefined;
    const bad = (at: string, why: string) => out.push(`${ex.where}${at}: ${why}`);
    const visit = (v: unknown, at: string, key: string, zone: string): void => {
      if (Array.isArray(v)) {
        if (key === 'byHour') hourBins(v, at, zone, bad);
        for (const [i, x] of v.entries()) visit(x, `${at}[${i}]`, key, zone);
        return;
      }
      if (v && typeof v === 'object') {
        const o = v as Json;
        const tz = typeof o.timeZone === 'string' ? o.timeZone : zone;
        settledError(o, at, bad);
        for (const [k, x] of Object.entries(o)) visit(x, `${at}.${k}`, k, tz);
        return;
      }
      if (typeof v !== 'string') return;
      if (PROSE_KEYS.test(key) && /\s/.test(v)) {
        const home = SENTENCE_HOME.get(v);
        if (!home)
          bad(at, `"${v.slice(0, 40)}" is free text no family wrote (tools/lib/example-text.ts)`);
        else if (home.family !== family)
          bad(at, `"${v.slice(0, 40)}" was written for ${home.family}, not ${family}`);
        else if (home.field !== key)
          bad(at, `"${v.slice(0, 40)}" was written for ${home.field}, not ${key}`);
      }
      if (ERROR_KEYS.test(key) && CODE.test(v)) {
        codes ??= allowedCodes(doc, ex.op);
        if (!codes.has(v)) bad(at, `error code ${v} is not one ${ex.op} can carry`);
      }
      if (key === 'name' && PEOPLE.has(v) && isSessionName(ex.op, at))
        bad(
          at,
          `the scanning session is named after a person (${v}); name it for a place or shift`,
        );
    };
    visit(ex.value, '', '', 'America/Los_Angeles');
  }
  return out;
}

/** A scanning session's own name: under a `session` key, or the root or items of a scanning-session operation. */
const isSessionName = (op: string, at: string): boolean =>
  familyOf(op) === 'scan' &&
  (/\.sessions?(\[\d+\])?\.name$/.test(at) ||
    (/ScanningSessions/.test(op) && /^(\.items\[\d+\])?\.name$/.test(at)));

function settledError(o: Json, at: string, bad: (at: string, why: string) => void): void {
  const state = [o.state, o.status, o.outcome].find((s) => typeof s === 'string') as
    | string
    | undefined;
  if (!state || !SETTLED.test(state)) return;
  for (const [k, v] of Object.entries(o))
    if (ERROR_KEYS.test(k) && typeof v === 'string' && v.length)
      bad(`${at}.${k}`, `a ${state} record carries the error ${v}`);
}

function hourBins(
  bins: unknown[],
  at: string,
  zone: string,
  bad: (at: string, why: string) => void,
): void {
  let last = -1;
  for (const [i, b] of bins.entries()) {
    const o = (b ?? {}) as Json;
    const where = `${at}[${i}]`;
    if (typeof o.count === 'number' && typeof o.refused === 'number' && o.refused > o.count)
      bad(where, 'more refused than scanned in the hour');
    // A start that is not a time is the time rule's (example-lint.ts); order and label need one.
    if (typeof o.start !== 'number' || o.start < 1_000_000_000_000) continue;
    if (o.start <= last) bad(where, 'hour bins are not in order, oldest first');
    last = o.start;
    if (typeof o.label === 'string') {
      const local = localHourOf(o.start, zone);
      if (!HOUR_LABEL.test(o.label)) bad(where, `hour label "${o.label}" is not HH:00`);
      else if (local === undefined) bad(where, `unknown time zone ${zone}`);
      else if (local !== o.label)
        bad(where, `hour label ${o.label} is not the local hour of its start in ${zone}`);
    }
  }
}
