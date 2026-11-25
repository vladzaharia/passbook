/** Words on a printed sheet that depend on what the sheet is. "Ticket" appears only on tickets. */
import type { PaperKind } from '../../passkit/template/paper.ts';

/** What the phone copy is called, from the class and the template's own word. */
export function paperNoun(kind: PaperKind, kicker: string): string {
  if (/ticket/i.test(kicker)) return 'ticket';
  if (/pass|card|badge/i.test(kicker)) return /badge/i.test(kicker) ? 'badge' : 'pass';
  switch (kind) {
    case 'admission':
    case 'journey':
      return 'ticket';
    case 'badge':
      return 'badge';
    case 'credential':
      return 'card';
    default:
      return 'pass';
  }
}

const CODE = {
  ticket: 'Ticket code',
  booking: 'Booking code',
  badge: 'Badge code',
  card: 'Card code',
  pass: 'Pass code',
} as const;

/** The label over the typed print code. A permit, coupon and pickup name their own. */
export function codeLabelOf(kind: PaperKind, noun: string, pack = false): string {
  if (kind === 'permit') return 'Permit code';
  if (kind === 'coupon') return pack ? 'Pack code' : 'Coupon code';
  if (kind === 'pickup') return 'Slip code';
  if (kind === 'membership') return 'Card code';
  if (kind === 'booking' || kind === 'stay') return 'Booking code';
  return CODE[noun as keyof typeof CODE] ?? CODE.pass;
}

/** Kinds that fold in half on a full page; a card or badge is cut out, never folded. */
export const FOLDING_KINDS: readonly PaperKind[] = ['admission', 'journey', 'booking', 'stay'];

/** The default "Bring" line. */
export function bringLine(kind: PaperKind, noun: string): string {
  if (kind === 'membership' || kind === 'credential') return 'Your card or phone pass';
  if (kind === 'badge') return 'Your badge or phone pass';
  return `This page or your phone ${noun}`;
}

/** The "At the door" rule, in the words of what is printed. */
export function doorRule(kind: PaperKind, code: string): [string, string] {
  const staff = `Staff can type the ${code.toLowerCase()}.`;
  if (kind === 'journey') return ['At the gate', `Keep the code flat and unmarked. ${staff}`];
  if (kind === 'stay') return ['At the desk', `Keep the code flat and unmarked. ${staff}`];
  if (kind === 'booking') return ['On arrival', `Show the code at the desk. ${staff}`];
  if (kind === 'badge' || kind === 'credential' || kind === 'membership')
    return ['Showing it', `Keep the code clean and unfolded. ${staff}`];
  return ['At the door', `Keep the code flat and unmarked. ${staff}`];
}

/** "Before you go" on a full page; a stay and an order name what they are. */
export function beforeHeading(kind: PaperKind): string {
  if (kind === 'pickup') return 'Your order';
  if (kind === 'stay') return 'Your stay';
  if (kind === 'booking') return 'Your booking';
  return 'Before you go';
}

/** Short labels of the new classes' facts. */
export const KIND_LABELS = {
  from: 'From',
  to: 'To',
  departs: 'Departs',
  boards: 'Boards',
  seat: 'Seat',
  party: 'Party',
  group: 'Group',
  gate: 'Gate',
  with: 'With',
  where: 'Where',
  status: 'Status',
  checkIn: 'Check-in',
  checkOut: 'Check-out',
  nights: 'Nights',
  room: 'Room',
  host: 'Host',
  zone: 'Zone',
  goTo: 'Go to',
  company: 'Company',
  arrives: 'Arrives',
  validUntil: 'Valid until',
  holder: 'Name',
  issuedBy: 'Issued by',
  issued: 'Issued',
  number: 'Number',
  reward: 'Reward',
  plan: 'Plan',
  packOf: (what: string) => `Pack of ${what}`,
} as const;
