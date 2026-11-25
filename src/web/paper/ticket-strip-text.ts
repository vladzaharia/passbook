/** The words and type sizes of a one-row strip (stub, ATB, A6, DL). Pure; the page and the PDF both read it. */
import type { PaperContent } from '../../passkit/template/paper-content.ts';
import { STRIP_COMPACT_H } from '../../passkit/template/paper-geometry-sizes.ts';
import { doorRows, doorWhen } from './ticket-text.ts';
import { stripNote } from './ticket-text-kinds.ts';

export interface StripText {
  /** Compact strips (the stub) drop the brand row and the facts boxes. */
  compact: boolean;
  brand: string;
  kicker: string;
  title: string;
  when?: string | undefined;
  venue?: string | undefined;
  rows: { label: string; text: string }[];
  /** A narrow text panel lists the facts in a column instead of three boxes. */
  stacked: boolean;
}

export const isCompactStrip = (heightMm: number): boolean => heightMm < STRIP_COMPACT_H;

const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ');

/** Panels narrower than this list their facts in a column. */
export const STRIP_STACK_W = 100;

export function stripText(c: PaperContent, heightMm: number, faceW: number): StripText {
  const compact = isCompactStrip(heightMm);
  return {
    compact,
    brand: c.brand,
    kicker: c.kicker,
    title: c.title,
    when: doorWhen(c),
    venue: stripNote(c) ?? (compact ? join(c.venue, c.room) : join(c.venue, c.address, c.room)),
    rows: doorRows(c),
    stacked: faceW < STRIP_STACK_W,
  };
}

/** Type sizes in mm (the PDF's unit; the CSS multiplies them by `--mm`). */
export interface StripType {
  pad: number;
  plate: number;
  kicker: number;
  title: number;
  when: number;
  venue: number;
  rowLabel: number;
  rowValue: number;
  typed: number;
  foot: number;
  titleLines: number;
}

export function stripType(heightMm: number): StripType {
  if (isCompactStrip(heightMm))
    return {
      pad: 3.5,
      plate: 0,
      kicker: 1.9,
      title: 5,
      when: 3,
      venue: 2.8,
      rowLabel: 0,
      rowValue: 2.8,
      typed: 2.8,
      foot: 2.1,
      titleLines: 2,
    };
  const tall = heightMm > 90;
  return {
    pad: 6,
    plate: tall ? 9 : 8,
    kicker: 2.2,
    title: tall ? 7.6 : 7,
    when: 3.6,
    venue: 3.2,
    rowLabel: 2,
    rowValue: 3.8,
    typed: 3.7,
    foot: 2.3,
    titleLines: 2,
  };
}
