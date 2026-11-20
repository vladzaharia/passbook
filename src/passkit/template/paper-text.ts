import type { PaperContent } from './paper-content.ts';
import { paperDate } from './paper-format.ts';

/** The ticket's facts as plain strings: what a renderer that draws one text block per fact needs. */
export interface PaperPlain {
  brand: string;
  event: string;
  date?: string;
  venue?: string;
  holder?: string;
  type?: string;
  seat?: string;
  terms?: string;
  extras: { label?: string; text: string }[];
}

export function paperPlain(c: PaperContent): PaperPlain {
  const at = c.start ?? c.validUntil;
  const seat = [
    c.seat?.section && `Section ${c.seat.section}`,
    c.seat?.row && `Row ${c.seat.row}`,
    c.seat?.seat && `Seat ${c.seat.seat}`,
  ].filter(Boolean);
  const venue = [c.venue, c.address].filter(Boolean).join(', ');
  return {
    brand: c.brand,
    event: c.title,
    ...(at ? { date: paperDate(at, c.zone, c.start ? 'stamp' : 'short') } : {}),
    ...(venue ? { venue } : {}),
    ...(c.holder ? { holder: c.holder } : {}),
    ...(c.type ? { type: c.type } : {}),
    ...(seat.length ? { seat: seat.join(', ') } : {}),
    ...(c.terms ? { terms: c.terms } : {}),
    extras: c.extras,
  };
}
