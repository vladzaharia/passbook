/** Journey, booking and stay: what the door and the traveller read off a trip's paper. */
import { paperNights } from './paper-format.ts';
import { ISO, type Kinded, type KindParts, str, text, when } from './paper-kinds-base.ts';

/** A route label that only says which end it is, not the place. */
const GENERIC = /^(from|to|origin|destination|depart(?:s|ure)?|arriv(?:es|al)|where)$/i;

const place = (c: Kinded, keys: string[], cityKey: string) => {
  const m = c.meta(...keys);
  if (!m) return undefined;
  const city =
    str(c.semantics[cityKey]) ?? (m.label && !GENERIC.test(m.label) ? m.label : undefined);
  return { main: m.text, ...(city && city !== m.text ? { city } : {}) };
};

/** Fields that read as extras on a stay or a journey: whatever the pass lists beyond the core facts. */
const extrasOf = (c: Kinded, skip: string[]): string | undefined => {
  const out = c.all
    .filter(
      (f) =>
        /^(auxiliary|secondary)Fields\./.test(f.path) &&
        !skip.includes(f.key) &&
        !ISO.test(f.text) &&
        f.label,
    )
    .map((f) => `${f.label}: ${f.text}`)
    .slice(0, 3);
  return out.length ? out.join(' · ') : undefined;
};

export function tripParts(c: Kinded, parts: KindParts, seat: NonNullable<KindParts['seat']>): void {
  const { info } = parts;
  const set = (key: keyof typeof info, v: string | undefined) => {
    if (v) info[key] = v;
  };
  if (c.kind === 'journey') {
    const from = place(c, ['origin', 'from'], 'departureCityName');
    const to = place(c, ['destination', 'to'], 'destinationCityName');
    parts.title = [from?.main, to?.main].filter(Boolean).join(' → ') || undefined;
    set('from', from?.main);
    set('fromCity', from?.city);
    set('to', to?.main);
    set('toCity', to?.city);
    const ride = c.meta('flight', 'vessel', 'train', 'service', 'route', 'line');
    set('vehicle', ride?.text);
    set('vehicleLabel', ride?.label);
    const gate = c.meta('gate', 'platform', 'lane', 'dock', 'berth', 'track');
    set('gate', gate?.text);
    set('gateLabel', gate?.label);
    const boards = c.meta('boardsAt', 'boardBy', 'boards');
    if (boards && ISO.test(boards.text)) {
      info.boards = boards.text;
      set('boardsLabel', boards.label);
    }
    set('group', c.field('group', 'boardingGroup'));
    const arrives =
      when(c, undefined, 'arrives', 'arrivesAt') ?? str(c.semantics.originalArrivalDate);
    if (arrives && ISO.test(arrives)) {
      info.arrives = arrives;
      set('arrivesZone', str(c.semantics.destinationLocationTimeZone));
    }
    set('party', c.field('party'));
    const loose = Object.keys(seat).length ? undefined : c.field('seat');
    if (loose) seat.seat = loose;
    if (Object.keys(seat).length) parts.seat = seat;
    const car = c.meta('vehicle', 'plate');
    set('included', car && `${car.label ?? 'Vehicle'}: ${car.text}`);
    for (const [label, text] of [
      [info.gateLabel ?? 'Gate', info.gate],
      ['Seat', seat.seat],
      [info.party ? 'Party' : 'Group', info.party ?? info.group],
    ] as const)
      if (text) parts.facts.push({ label, text });
    return;
  }
  if (c.kind === 'booking') {
    const lead = text(c.roles.title);
    parts.title = c.field('what', 'service') ?? (lead && !ISO.test(lead) ? lead : undefined);
    const where = c.field('where', 'location');
    if (where) parts.venue = where;
    set('with', c.field('with', 'provider', 'staff'));
    set('status', c.field('status'));
    for (const [label, v] of [
      ['With', info.with],
      ['Where', where],
      ['Status', info.status],
    ] as const)
      if (v) parts.facts.push({ label, text: v });
    return;
  }
  // stay
  parts.title = parts.holder;
  const nights = parts.start && parts.end ? paperNights(parts.start, parts.end) : 0;
  if (nights) info.nights = String(nights);
  set('included', extrasOf(c, ['holder', 'in', 'out', 'room', 'status']));
  if (parts.room) parts.facts.push({ label: 'Room', text: parts.room });
  if (nights) parts.facts.push({ label: 'Nights', text: String(nights) });
}
