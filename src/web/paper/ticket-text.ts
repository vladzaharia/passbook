/** The words on a ticket, per class and panel, from the renderer-neutral content. Pure. */
import type { PaperContent } from '../../passkit/template/paper-content.ts';
import { paperDate, paperZoneFor, paperZoneInfo } from '../../passkit/template/paper-format.ts';
import { PAPER_COPY } from '../../shared/copy/print.ts';

export interface Issued {
  generation: number;
  /** ISO time the print was made. */
  at?: string;
}

export interface Line {
  big?: boolean;
  text: string;
}
export interface Column {
  title: string;
  strong?: string;
  lines?: string[];
  list?: string[];
  boxes?: boolean;
}

const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ');
const at = (c: PaperContent, iso: string | undefined, style: Parameters<typeof paperDate>[2]) =>
  iso ? paperDate(iso, paperZoneFor(c, iso), style) : '';
const abbrAt = (c: PaperContent, iso: string) => {
  const zone = paperZoneFor(c, iso);
  return zone ? paperZoneInfo(zone, iso)?.abbr : undefined;
};
/** The start and the end read in different zones: each carries its own abbreviation. */
const splitZones = (c: PaperContent) =>
  Boolean(c.start && c.end && abbrAt(c, c.start) !== abbrAt(c, c.end));
const startAt = (c: PaperContent, start: string) =>
  splitZones(c) ? `${at(c, start, 'timeZone')}` : at(c, start, 'time');
/** The end's clock: its day when it is another day, its own zone when that differs from the start's. */
const endAt = (c: PaperContent, end: string) => {
  const clock =
    c.start && at(c, end, 'long') !== at(c, c.start, 'long')
      ? `${at(c, end, 'short')}, ${at(c, end, 'time')}`
      : at(c, end, 'time');
  const own = abbrAt(c, end);
  return own && c.start && own !== abbrAt(c, c.start) ? `${clock} ${own}` : clock;
};
const zoneAbbr = (c: PaperContent) => {
  const iso = c.start ?? c.validUntil;
  return c.zone && iso ? paperZoneInfo(c.zone, iso)?.abbr : undefined;
};

/** `Sat 13 Feb 2027 · 7:30 pm NZDT`, or what the pass is valid until. */
export function doorWhen(c: PaperContent): string | undefined {
  if (c.start) return `${at(c, c.start, 'short')} · ${at(c, c.start, 'timeZone')}`;
  if (!c.validUntil) return undefined;
  if (c.kind === 'pickup') return `Collect by ${at(c, c.validUntil, 'stamp')}`;
  return `${c.kind === 'membership' ? 'Valid to' : 'Valid until'} ${at(c, c.validUntil, 'short')}`;
}

/** The three facts under the door panel's code. */
export function doorRows(c: PaperContent): { label: string; text: string }[] {
  const seat = c.seat && [c.seat.section, c.seat.row, c.seat.seat].filter(Boolean).join(' · ');
  const rows =
    c.kind === 'membership'
      ? [
          { label: 'Tier', text: c.type },
          { label: 'Club', text: c.venue },
          { label: 'Valid to', text: c.validUntil ? at(c, c.validUntil, 'short') : undefined },
        ]
      : c.kind === 'pickup'
        ? [
            { label: 'Name', text: c.holder },
            { label: 'Where', text: c.room },
            { label: 'Items', text: c.facts.find((f) => f.label === 'Items')?.text },
          ]
        : [
            { label: 'Name', text: c.holder },
            { label: c.noun === 'pass' ? 'Pass' : 'Ticket', text: c.type },
            { label: 'Seat', text: seat },
          ];
  return rows.filter((r): r is { label: string; text: string } => Boolean(r.text)).slice(0, 3);
}

const timesLine = (c: PaperContent): string | undefined => {
  const parts = [
    c.doors && `Doors ${at(c, c.doors, 'time')}`,
    c.start && `Starts ${startAt(c, c.start)}`,
    c.end && `Ends ${endAt(c, c.end)}`,
  ].filter(Boolean);
  if (!parts.length) return undefined;
  const abbr = splitZones(c) ? undefined : zoneAbbr(c);
  return `${parts.join(' · ')}${abbr ? ` (${abbr})` : ''}`;
};

/** Lines that fit above the seat boxes on a sheet (7) and a half sheet (6), measured on a full ticket. */
const MAX_FACE_LINES = 7;
const MAX_HALF_LINES = 6;

/** The half sheet's notes only have room under a short panel. */
export const faceNotesFit = (lines: readonly Line[]) => lines.length <= 4;

/** The holder panel's text under the band, largest first. */
export function faceLines(c: PaperContent, half = false): Line[] {
  const lines: Line[] = [];
  const big = (text: string | undefined) => text && lines.push({ big: true, text });
  const sub = (text: string | undefined) => text && lines.push({ text });
  if (c.kind === 'membership') {
    big(c.type);
    sub(c.venue);
    big(c.validUntil && `Valid to ${at(c, c.validUntil, 'long')}`);
  } else if (c.kind === 'pickup') {
    big(c.room && `Collect from ${c.room}`);
    sub(c.address);
    big(c.validUntil && `By ${at(c, c.validUntil, 'long')}, ${at(c, c.validUntil, 'timeZone')}`);
  } else if (c.start) {
    big(at(c, c.start, 'long'));
    sub(timesLine(c));
    big(c.venue);
    sub(join(c.address, c.room));
    // The door panel already says who and what; a half sheet has no room to say it twice.
    if (!half) sub(join(c.holder, c.type));
  } else {
    big(c.validUntil && `Use by ${at(c, c.validUntil, 'long')}`);
    big(c.venue);
    sub(join(c.address, c.room));
    sub(join(c.holder, c.type));
  }
  // The panel has a fixed height: extras past the cap would run into the fact boxes.
  const cap = half ? MAX_HALF_LINES : MAX_FACE_LINES;
  for (const e of c.extras) if (lines.length < cap) sub(e.label ? `${e.label}: ${e.text}` : e.text);
  return lines;
}

const strong = (text: string | undefined) => (text ? { strong: text } : {});

/** The three columns of "Before you go". */
export function infoColumns(c: PaperContent): Column[] {
  const bring: Column = { title: 'Bring', list: c.bring };
  const whereLines = [c.address, c.room, c.directions].filter((x): x is string => Boolean(x));
  const where: Column = { title: 'Where', ...strong(c.venue), lines: whereLines };
  if (c.kind === 'pickup') {
    return [
      { title: 'Items', list: c.items ?? [], boxes: true },
      {
        title: 'Where',
        ...strong(c.room),
        lines: [c.address].filter((x): x is string => Boolean(x)),
      },
      bring,
    ].filter((col) => col.title === 'Bring' || col.list?.length || col.strong || col.lines?.length);
  }
  if (c.kind === 'membership') {
    return [
      {
        title: 'Valid',
        ...strong(c.validUntil && `To ${at(c, c.validUntil, 'long')}`),
        lines: [c.type].filter((x): x is string => Boolean(x)),
      },
      { ...where, title: 'Club' },
      bring,
    ];
  }
  const abbr = zoneAbbr(c);
  const info =
    c.zone && (c.start ?? c.validUntil)
      ? paperZoneInfo(c.zone, (c.start ?? c.validUntil) as string)
      : undefined;
  const when: Column = c.start
    ? {
        title: 'When',
        ...strong(at(c, c.start, 'long')),
        lines: [
          c.doors && `Doors open ${at(c, c.doors, 'time')}`,
          `Show starts ${startAt(c, c.start)}`,
          c.end && `Ends about ${endAt(c, c.end)}`,
          abbr && info && !splitZones(c) ? PAPER_COPY.zoneNote(info.abbr, info.name) : undefined,
        ].filter((x): x is string => Boolean(x)),
      }
    : {
        title: 'Valid',
        ...strong(c.validUntil && `Until ${at(c, c.validUntil, 'long')}`),
        lines: [],
      };
  return [when, where, bring];
}

/** The wash box under the columns: up to four rules. */
export function rules(c: PaperContent, fold: boolean): [string, string][] {
  const out: [string, string][] = [
    [...PAPER_COPY.oneTicket(c.noun, c.once)] as [string, string],
    [...PAPER_COPY.reprints] as [string, string],
  ];
  if (c.kind === 'admission' || c.kind === 'membership')
    out.push([...PAPER_COPY.atDoor] as [string, string]);
  if (fold) out.push([...PAPER_COPY.folding] as [string, string]);
  return out.slice(0, 4);
}

/** `Print 1 · Issued 19 Nov 2026, 2:02 pm NZDT`. */
export function footMeta(c: PaperContent, issued: Issued | undefined): string {
  const n = issued?.generation ?? 1;
  if (!issued?.at) return `Print ${n}`;
  return PAPER_COPY.issued(n, paperDate(issued.at, c.zone, 'stamp'));
}

/** A half sheet's "Before you go": when and where in one line, when the pass has both. */
export function compactBefore(c: PaperContent): string | undefined {
  const when = c.doors
    ? `Doors ${at(c, c.doors, 'time')}`
    : c.start
      ? `Starts ${at(c, c.start, 'time')}`
      : c.validUntil
        ? `Until ${at(c, c.validUntil, 'short')}`
        : undefined;
  const where = join(c.venue, c.address);
  return when && where ? `${when} · ${where}` : undefined;
}

/** `1 Dec – 31 Dec 2026` for a validity range, `Until ...` for an end alone. */
export function rangeText(c: PaperContent): string | undefined {
  if (!c.validUntil) return undefined;
  if (!c.validFrom) return `Until ${at(c, c.validUntil, 'short')}`;
  const from = at(c, c.validFrom, 'short').replace(/^\w+ /, '');
  const to = at(c, c.validUntil, 'short').replace(/^\w+ /, '');
  const sameYear = from.slice(-4) === to.slice(-4);
  return `${sameYear ? from.slice(0, -5) : from} – ${to}`;
}

/** `31 Dec, 11:59 pm`. */
export function endsText(c: PaperContent): string | undefined {
  return c.validUntil ? at(c, c.validUntil, 'stamp').replace(/ \d{4},/, ',') : undefined;
}

export { at as paperAt };
