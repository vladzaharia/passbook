import type { PaperTicket } from './paper.ts';
import { canonical } from './pdf-cache.ts';

/** Bump only when the hashed set below changes meaning: a bump marks every active print stale, so keep it rare. */
export const PAPER_HASH_V = 1;

/**
 * sha256 of the pass-derived values a ticket shows. `bring` is left out: it is template copy, not a pass
 * value. Not the design, kind, ink, colours, noun, kicker or any copy: a deploy that changes how paper looks or reads must not mark printed tickets stale.
 * Not the code, print number or time either. "Current" therefore means re-drawn from these values, not that
 * the paper on hand is new.
 */
export async function paperHash(ticket: PaperTicket): Promise<string> {
  const c = ticket.content;
  const values = {
    title: c.title,
    start: c.start,
    end: c.end,
    doors: c.doors,
    validFrom: c.validFrom,
    validUntil: c.validUntil,
    zone: c.zone,
    venue: c.venue,
    address: c.address,
    room: c.room,
    directions: c.directions,
    holder: c.holder,
    type: c.type,
    seat: c.seat,
    facts: c.facts.map((f) => f.text),
    items: c.items,
    hero: c.hero,
    terms: c.terms,
    extras: c.extras,
    // From the pass's contact, phone, support and site fields.
    help: c.help,
    brand: c.brand,
  };
  const data = new TextEncoder().encode(`v${PAPER_HASH_V}:${canonical(values)}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}
