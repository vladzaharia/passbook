/** `ticket/*`: needs an event name and start, a reservation number, a logo and a main image. */

import { measure } from '../text.ts';
import type { WalletPassView, WalletRole } from '../types.ts';
import { finishCard, firstText } from './card.ts';
import { setAppLink, setBarcode, setContacts, setLocations } from './code.ts';
import { note, type Run, setDisplay, setWhole } from './context.ts';
import { eventWindow, setWindow } from './dates.ts';
import { SAMSUNG_LIMITS } from './limits.ts';
import { pickImage, setColors, setImage } from './media.ts';

export type TicketSubType = 'others' | 'performances' | 'sports' | 'movies' | 'entrances';

const TICKET_NATIVE: readonly WalletRole[] = [
  'title',
  'eventName',
  'eventStart',
  'eventEnd',
  'eventId',
  'validFrom',
  'validUntil',
  'appLink',
  'support',
];

const EVENT_TYPES: Record<string, TicketSubType> = {
  PKEventTypeMovie: 'movies',
  PKEventTypeSports: 'sports',
  PKEventTypePerformance: 'performances',
};

/** The subtype the author set, else the pass's `eventType` tag, else `others`. */
export function ticketSubType(view: WalletPassView, configured?: TicketSubType): TicketSubType {
  if (configured) return configured;
  for (const field of view.fields) {
    const tag = (field.semantics as Record<string, unknown> | undefined)?.eventType;
    if (typeof tag === 'string' && EVENT_TYPES[tag]) return EVENT_TYPES[tag];
  }
  return 'others';
}

const mainImage = (view: WalletPassView) =>
  pickImage(view, 'main', ['artwork', 'strip', 'background']);
const logoImage = (view: WalletPassView) => pickImage(view, 'logo', ['logo', 'primaryLogo']);

/** The role that gives `reservationNumber`, else the first barcode message that fits. */
function reservation(view: WalletPassView): { role?: WalletRole; text: string } | undefined {
  for (const role of ['confirmationCode', 'ticketNumber'] as const) {
    const value = view.roles[role];
    if (value?.kind === 'text') return { role, text: value.text };
  }
  const code = view.barcodes.find((b) => b.kind !== 'other');
  return code && measure(code.message, 'bytes') <= SAMSUNG_LIMITS.reservationNumber.max
    ? { text: code.message }
    : undefined;
}

/** What a ticket needs that this pass lacks, or undefined. */
export function ticketUnmet(view: WalletPassView): string | undefined {
  const missing = [
    !view.roles.eventName && 'an event name',
    view.roles.eventStart?.kind !== 'date' && 'a start time',
    !reservation(view) && 'a reservation number',
    !logoImage(view) && 'a logo',
    !mainImage(view) && 'a main image',
  ].filter(Boolean);
  return missing.length > 0 ? missing.join(', ') : undefined;
}

export function buildTicket(run: Run): void {
  const { view, opts } = run;
  const used = new Set<string>();
  const native = new Set<WalletRole>(TICKET_NATIVE);
  setDisplay(run, 'title', firstText(run, 'eventName', 'title'));
  setDisplay(run, 'providerName', view.org);
  const appLink = setAppLink(run);

  const logo = logoImage(view);
  if (logo) used.add(logo.slot);
  setImage(run, 'logoImage', logo, 'image.logo');
  const main = mainImage(view);
  if (main) used.add(main.slot);
  setImage(run, 'mainImg', main, 'image.artwork');
  setColors(run);

  run.attrs.issueDate = String((opts.issuedAt ?? opts.now).getTime());
  const window = eventWindow(run, ['eventStart', 'validFrom'], ['eventEnd', 'validUntil']);
  setWindow(run, window);

  const booked = reservation(view);
  if (booked) {
    setWhole(run, 'reservationNumber', booked.text, 'IDENTITY_TOO_LONG', 'The reservation number');
    if (booked.role) native.add(booked.role);
  }
  const eventId = view.roles.eventId;
  if (eventId?.kind === 'text') {
    if (measure(eventId.text, 'bytes') <= SAMSUNG_LIMITS.eventId.max)
      run.attrs.eventId = eventId.text;
    else note(run, 'role.eventId', '', 'omitted', 'The event id is longer than Samsung allows.');
  }

  const serial = setBarcode(run);
  setLocations(run);
  const contacts = setContacts(run);
  finishCard(run, { native, usedImages: used, serial, contacts, appLink });
  run.attrs.noticeDesc ??= run.tr(view.description);
}
