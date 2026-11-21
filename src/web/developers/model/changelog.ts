import { PATHS } from '../../../shared/developers.ts';
import { escapeHtml } from '../../../shared/html.ts';
import type { ChangeEntry, RawChangeFile, Site } from './types.ts';

/** The dated files as one list, newest file first; an entry keeps its file's order. */
export function buildChangelog(files: RawChangeFile[], areaOf: Map<string, string>): ChangeEntry[] {
  return [...files]
    .sort((a, b) => b.date.localeCompare(a.date))
    .flatMap((f) =>
      f.entries.map((e) => {
        const ops = e.ops ?? [];
        const areas = new Set(ops.map((id) => areaOf.get(id) ?? 'General'));
        return {
          date: f.date,
          kind: e.kind,
          text: e.text,
          ops,
          area: areas.size === 1 ? [...areas][0] : 'General',
          breaking: e.breaking === true,
          version: e.version ?? null,
        } as ChangeEntry;
      }),
    );
}

/** A short stable id part from the text, so a feed entry keeps its id when the file is reordered. */
function hash(text: string): string {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0).toString(36);
}

/** The Atom feed of the changelog: one entry per line, dated at midnight UTC. */
export function atomFeed(site: Site, origin: string): string {
  const stamp = (date: string) => `${date}T00:00:00Z`;
  const updated = site.changelog[0]?.date ?? '2026-11-20';
  const entries = site.changelog
    .map((e) => {
      const title = `${e.breaking ? 'Breaking: ' : ''}${e.text}`;
      return (
        `<entry><title>${escapeHtml(title)}</title>` +
        `<id>tag:passbook.mobile,${e.date}:${hash(e.text)}</id>` +
        `<updated>${stamp(e.date)}</updated>` +
        `<category term="${escapeHtml(e.kind)}"/>` +
        `<link rel="alternate" href="${origin}${PATHS.changelog}"/>` +
        `<content type="text">${escapeHtml(e.text)}</content></entry>`
      );
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<feed xmlns="http://www.w3.org/2005/Atom"><title>PassBook API changelog</title>' +
    `<id>${origin}${PATHS.changelog}</id><updated>${stamp(updated)}</updated>` +
    `<link rel="self" type="application/atom+xml" href="${origin}${PATHS.changelogFeed}"/>` +
    `<link rel="alternate" type="text/html" href="${origin}${PATHS.changelog}"/>` +
    `<author><name>PassBook</name></author>${entries}</feed>\n`
  );
}
