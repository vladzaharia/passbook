// The changelog's machine part and its rules. Pure: no I/O. See tools/gen-changelog.ts.
import { type Change, changeHolds, type Doc, SUNSET_REMOVAL } from './openapi-diff.ts';

export type Kind = 'Added' | 'Changed' | 'Fixed' | 'Removed';

/** One line in docs/api/changelog/<date>.json. `ops` are operationIds; `breaking` entries name their `version`. */
export interface Entry {
  kind: Kind;
  text: string;
  ops?: string[];
  breaking?: boolean;
  version?: string;
  /** The entry describes every machine change to `ops`, so none of them needs a note of its own. */
  covers?: boolean;
}
export interface DatedFile {
  date: string;
  entries: Entry[];
}

/** docs/api/changelog/unreleased.json: the diff against main, plus the author's one-line note. */
export interface Pending {
  key: string;
  class: Change['class'];
  operationId: string;
  op: string;
  change: string;
  note: string;
  /**
   * A breaking change that ships to every client without a PassBook-Version: a fix that stops a request reaching more than it
   * asked, or a status code that only a signed-in browser session ever receives (no key, so no integration, calls it).
   */
  unversioned?: boolean;
}

/** docs/api/versions.json. `migration` says what a client pinned to an older date must change. */
export interface ApiVersion {
  date: string;
  summary: string;
  migration: string;
}
export interface Versions {
  versions: ApiVersion[];
}

export const pendingKey = (c: Pick<Change, 'op' | 'text'>): string => `${c.op} ${c.text}`;

/** Existing entries stay (they wait for the next release, even once main has them); new changes arrive without a note. */
export function mergePending(existing: Pending[], changed: Change[]): Pending[] {
  const have = new Map(existing.map((p) => [p.key, p]));
  for (const c of changed) {
    const key = pendingKey(c);
    if (!have.has(key))
      have.set(key, {
        key,
        class: c.class,
        operationId: c.operationId,
        op: c.op,
        change: c.text,
        note: '',
      });
  }
  return [...have.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * A change missing from the file, an entry with no note, a note that is not one line, or (given the
 * current spec) an entry for a field, enum value or operation the spec no longer has.
 */
export function changelogFailures(existing: Pending[], changed: Change[], spec?: Doc): string[] {
  const out: string[] = [];
  if (spec)
    for (const p of existing)
      if (!changeHolds(spec, p.op, p.change))
        out.push(`${p.key}: no longer in the spec; remove it from unreleased.json`);
  const have = new Set(existing.map((p) => p.key));
  for (const c of changed)
    if (!have.has(pendingKey(c)))
      out.push(`${pendingKey(c)}: not in unreleased.json; run npm run gen`);
  for (const p of existing) {
    const note = p.note.trim();
    if (!note) out.push(`${p.key}: needs a one-line note in unreleased.json`);
    else if (note.includes('\n') || note.length > 160)
      out.push(`${p.key}: the note is one line, 160 characters at most`);
  }
  return out;
}

/** Versions in `next` that `base` lacks, and the ones without a migration note. */
export function versionFailures(next: Versions, base: Versions | null): string[] {
  const out: string[] = [];
  const dates = next.versions.map((v) => v.date);
  if (new Set(dates).size !== dates.length) out.push('versions.json: a date is listed twice');
  for (const v of next.versions) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) out.push(`versions.json: ${v.date} is not a date`);
    if (!v.migration.trim()) out.push(`versions.json: ${v.date} needs a migration note`);
  }
  for (const v of base?.versions ?? [])
    if (!dates.includes(v.date)) out.push(`versions.json: ${v.date} was removed`);
  return out;
}

export const hasNewVersion = (next: Versions, base: Versions | null): boolean =>
  next.versions.some((v) => !(base?.versions ?? []).some((b) => b.date === v.date));

/** The breaking changes no `unversioned` entry of unreleased.json covers, and that are not a removal at a Sunset. */
export const versionedBreaks = (
  broken: string[],
  pending: Pending[],
  /** The operation ("POST /a") is reached by a browser session only: no API key or other scheme admits it. */
  browserOnly: (op: string) => boolean = () => false,
): string[] => {
  // Only a request-side tightening, a response enum value removed before general availability (no API consumers yet), or a status only a browser session receives, may ship unversioned; a removed field or the like still needs a version.
  const free = new Set(
    pending
      .filter(
        (p) =>
          p.unversioned &&
          (p.change.endsWith(': unknown keys now refused') ||
            /: enum value ".+" removed$/.test(p.change)),
      )
      .map((p) => p.key),
  );
  // A route no key can call changes its status (a sandbox action now answers 202): the break is named in the notes.
  // An operation any other scheme admits keeps its version note: an integration may call it.
  for (const p of pending)
    if (p.unversioned && /^response \d{3} removed$/.test(p.change) && browserOnly(p.op))
      free.add(`${p.op}: ${p.change}`);
  // Removing an operation on or after the Sunset the base announced reaches every client whatever its version.
  return broken.filter((b) => !free.has(b) && !b.includes(`: ${SUNSET_REMOVAL} `));
};

/** True when every security requirement of the operation in `doc` is the browser `session` scheme and nothing else. */
export function sessionOnly(doc: Doc, op: string): boolean {
  const [method = '', path = ''] = op.split(' ');
  const item = doc.paths?.[path]?.[method.toLowerCase()] as
    | { security?: Record<string, unknown>[] }
    | undefined;
  const security = item?.security;
  return (
    !!security &&
    security.length > 0 &&
    security.every((r) => Object.keys(r).length > 0 && Object.keys(r).every((k) => k === 'session'))
  );
}

/** The dated file a release writes. Refuses while a note is missing. */
export function stamp(pending: Pending[], date: string, into?: DatedFile): DatedFile {
  const bare = pending.filter((p) => !p.note.trim());
  if (bare.length) throw new Error(`Notes missing: ${bare.map((p) => p.key).join('; ')}`);
  const entries: Entry[] = pending.map((p) => ({
    kind: p.change === 'new operation' ? 'Added' : 'Changed',
    text: p.note.trim(),
    ...(p.operationId ? { ops: [p.operationId] } : {}),
    ...(p.class === 'breaking' ? { breaking: true } : {}),
  }));
  return { date, entries: [...(into?.entries ?? []), ...entries] };
}

/**
 * The operations whose changes a released entry already describes. A file the base already carries
 * (`atBase`) was released before the changes being checked, so it covers none of them.
 */
export const coveredOps = (
  files: DatedFile[],
  atBase: ReadonlySet<string> = new Set(),
): Set<string> =>
  new Set(
    files
      .filter((f) => !atBase.has(f.date))
      .flatMap((f) => f.entries.filter((e) => e.covers).flatMap((e) => e.ops ?? [])),
  );
