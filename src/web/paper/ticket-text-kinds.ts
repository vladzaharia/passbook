/** The words of a journey, booking, stay, badge and credential on the door panel, holder panel and "before you go". */
import type { PaperContent } from '../../passkit/template/paper-content.ts';
import { paperDate, paperZoneFor, paperZoneInfo } from '../../passkit/template/paper-format.ts';
import { PAPER_COPY } from '../../shared/copy/print.ts';
import { KIND_LABELS as L } from '../../shared/copy/print-kinds.ts';
import { at, type Column, clockAt, join, type Line, zoneAbbr } from './ticket-text-base.ts';

type Row = { label: string; text: string };
const rowsOf = (rows: { label: string; text: string | undefined }[]): Row[] =>
  rows.filter((r): r is Row => Boolean(r.text));
const noYear = (s: string) => s.replace(/ \d{4}$/, '');
const named = (label: string | undefined, text: string | undefined) =>
  text ? (label ? `${label} ${text}` : text) : undefined;

/** `Boards 7:15 am · Departs 8:00 am (PDT)`. */
function tripTimes(c: PaperContent): string | undefined {
  const parts = [
    c.info.boards && `${c.info.boardsLabel ?? L.boards} ${at(c, c.info.boards, 'time')}`,
    c.start && c.kind === 'journey' && `${L.departs} ${at(c, c.start, 'time')}`,
    c.start && c.kind === 'booking' && at(c, c.start, 'time'),
  ].filter(Boolean);
  if (!parts.length) return undefined;
  const abbr = zoneAbbr(c);
  return `${parts.join(' · ')}${abbr ? ` (${abbr})` : ''}`;
}

/** `Arrives 4:30 pm EDT`, in the destination's own zone. */
const arrival = (c: PaperContent): string | undefined =>
  c.info.arrives
    ? `Arrives ${paperDate(c.info.arrives, c.info.arrivesZone ?? paperZoneFor(c, c.info.arrives), 'timeZone')}`
    : undefined;

const zoneLine = (c: PaperContent): string | undefined => {
  const iso = c.start ?? c.validUntil;
  const info = c.zone && iso ? paperZoneInfo(c.zone, iso) : undefined;
  return info ? PAPER_COPY.zoneNote(info.abbr, info.name) : undefined;
};

/** The line under the door panel's title. */
export function tripWhen(c: PaperContent): string | undefined {
  if (!c.start) return undefined;
  if (c.kind === 'stay')
    return c.end
      ? `${noYear(at(c, c.start, 'short'))} – ${at(c, c.end, 'short')}`
      : at(c, c.start, 'short');
  if (c.kind === 'journey')
    return `${at(c, c.start, 'short')} · ${L.departs} ${at(c, c.start, 'timeZone')}`;
  return `${at(c, c.start, 'short')} · ${at(c, c.start, 'timeZone')}`;
}

/** The facts staff check under the door panel's code. */
export function tripRows(c: PaperContent): Row[] {
  const seat = c.seat && [c.seat.section, c.seat.row, c.seat.seat].filter(Boolean).join(' · ');
  if (c.kind === 'journey')
    return rowsOf([
      { label: L.holder, text: c.holder },
      { label: c.info.gateLabel ?? L.gate, text: c.info.gate },
      { label: L.seat, text: seat },
      { label: L.party, text: c.info.party },
    ]).slice(0, 3);
  if (c.kind === 'booking')
    return rowsOf([
      { label: L.holder, text: c.holder },
      { label: L.with, text: c.info.with },
      { label: L.status, text: c.info.status },
    ]);
  return rowsOf([
    { label: L.holder, text: c.holder },
    { label: L.room, text: c.room },
    { label: L.nights, text: c.info.nights },
  ]);
}

/** The holder panel under the band. */
export function tripLines(c: PaperContent, half: boolean): Line[] {
  const lines: Line[] = [];
  const big = (text: string | undefined) => text && lines.push({ big: true, text });
  const sub = (text: string | undefined) => text && lines.push({ text });
  if (c.kind === 'journey') {
    big(c.start && at(c, c.start, 'long'));
    sub(tripTimes(c));
    sub(arrival(c));
    big(named(c.info.vehicleLabel, c.info.vehicle));
    sub(
      c.info.fromCity || c.info.toCity
        ? `${c.info.fromCity ?? c.info.from ?? ''} to ${c.info.toCity ?? c.info.to ?? ''}`
        : undefined,
    );
    if (!half) sub(c.holder);
    sub(c.info.included);
  } else if (c.kind === 'booking') {
    big(c.start && at(c, c.start, 'long'));
    sub(tripTimes(c));
    sub(join(c.address, c.directions));
    if (!half) sub(c.holder);
  } else {
    big(c.start && `${L.checkIn} ${noYear(at(c, c.start, 'short'))} · ${at(c, c.start, 'time')}`);
    big(c.end && `${L.checkOut} ${noYear(at(c, c.end, 'short'))} · ${clockAt(c, c.end)}`);
    sub(zoneLine(c));
    sub(join(c.venue, c.address));
    sub(c.info.included);
  }
  for (const e of c.extras)
    if (lines.length < (half ? 6 : 9)) sub(e.label ? `${e.label}: ${e.text}` : e.text);
  return lines;
}

/** "Before you go": when, where and what to bring. */
export function tripColumns(c: PaperContent, bring: Column): Column[] {
  if (c.kind === 'stay')
    return [
      {
        title: L.checkIn,
        ...(c.start ? { strong: at(c, c.start, 'long') } : {}),
        lines: [c.start && `From ${at(c, c.start, 'time')}`].filter((x): x is string => Boolean(x)),
      },
      {
        title: L.checkOut,
        ...(c.end ? { strong: at(c, c.end, 'long') } : {}),
        lines: [c.end && `By ${clockAt(c, c.end)}`, zoneLine(c)].filter((x): x is string =>
          Boolean(x),
        ),
      },
      bring,
    ];
  const when: Column = {
    title: 'When',
    ...(c.start ? { strong: at(c, c.start, 'long') } : {}),
    lines: [
      c.info.boards && `${c.info.boardsLabel ?? L.boards} ${at(c, c.info.boards, 'time')}`,
      c.start && `${c.kind === 'journey' ? L.departs : 'At'} ${at(c, c.start, 'time')}`,
      arrival(c),
      zoneLine(c),
    ].filter((x): x is string => Boolean(x)),
  };
  if (c.kind === 'booking')
    return [
      when,
      {
        title: L.where,
        ...(c.venue ? { strong: c.venue } : {}),
        lines: [c.address, c.room, c.directions].filter((x): x is string => Boolean(x)),
      },
      bring,
    ];
  return [
    when,
    {
      title: 'Route',
      lines: [
        c.info.from && `${L.from} ${join(c.info.from, c.info.fromCity)}`,
        c.info.to && `${L.to} ${join(c.info.to, c.info.toCity)}`,
        named(c.info.vehicleLabel, c.info.vehicle),
        named(c.info.gateLabel ?? L.gate, c.info.gate),
      ].filter((x): x is string => Boolean(x)),
    },
    bring,
  ];
}

/** `Valid: 18 Nov – 20 Nov 2030` from a start, else `Valid until ...`. */
const validity = (c: PaperContent): { label: string; text: string | undefined } =>
  c.validFrom && c.validUntil
    ? {
        label: 'Valid',
        text: `${noYear(at(c, c.validFrom, 'short'))} – ${at(c, c.validUntil, 'short')}`,
      }
    : { label: L.validUntil, text: c.validUntil && at(c, c.validUntil, 'short') };

/** The details a badge or credential prints, in order; the card faces and the page read this one list. */
export function idDetails(c: PaperContent): Row[] {
  const role = join(c.type, c.info.team);
  if (c.kind === 'credential')
    return rowsOf([
      { label: L.holder, text: c.holder },
      { label: L.number, text: c.info.number },
      { label: L.issuedBy, text: c.brand },
      { label: L.issued, text: c.info.issued && at(c, c.info.issued, 'short') },
      validity(c),
    ]);
  return rowsOf([
    { label: 'Role', text: role },
    { label: L.company, text: c.info.company },
    { label: L.host, text: c.info.host },
    { label: L.goTo, text: c.info.goTo },
    { label: L.zone, text: c.info.zone },
    { label: L.arrives, text: c.info.arrives && at(c, c.info.arrives, 'timeZone') },
    validity(c),
  ]);
}

export const idRows = (c: PaperContent): Row[] => {
  const d = idDetails(c);
  const pick = (...labels: string[]) => d.filter((r) => labels.includes(r.label));
  return (
    c.kind === 'credential'
      ? pick(L.holder, L.number, L.validUntil, 'Valid')
      : [{ label: L.holder, text: c.holder ?? '' }, ...pick('Role', L.validUntil, 'Valid')].filter(
          (r) => r.text,
        )
  ).slice(0, 3);
};

export function idLines(c: PaperContent, half: boolean): Line[] {
  const lines: Line[] = [];
  const d = idDetails(c);
  const first = d[0];
  if (c.kind === 'credential') {
    if (c.holder) lines.push({ big: true, text: c.holder });
    for (const r of d.slice(1, half ? 4 : 6)) lines.push({ text: `${r.label}: ${r.text}` });
    return lines;
  }
  if (first?.label === 'Role') lines.push({ big: true, text: first.text });
  for (const r of d.slice(first?.label === 'Role' ? 1 : 0, half ? 5 : 7))
    lines.push({ text: `${r.label}: ${r.text}` });
  return lines;
}

export function idColumns(c: PaperContent, bring: Column): Column[] {
  const d = idDetails(c);
  const skip = c.kind === 'credential' ? [] : ['Role'];
  return [
    {
      title: 'Details',
      lines: d.filter((r) => !skip.includes(r.label)).map((r) => `${r.label}: ${r.text}`),
    },
    bring,
  ];
}
