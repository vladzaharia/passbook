/** Google Event ticket: one class per event, one object per ticket (architecture 3.1, Q17). */
import { heroOf, LOGO, logoOf, objectCommon, typedClass, wideLogoOf } from './common.ts';
import { makeCompiler } from './compile.ts';
import type { Ctx } from './ctx.ts';
import { IDENTITY, TEXT } from './limits.ts';
import { dateLosses, locationsOf } from './parts.ts';
import type { GoogleEventClass, GoogleEventObject } from './types.ts';
import { rfc3339 } from './values.ts';

const SEAT_ROLES = ['seat', 'row', 'section', 'gate'] as const;

function dateOf(ctx: Ctx, role: 'eventStart' | 'eventEnd' | 'doorsOpen'): string | undefined {
  const value = ctx.take(role);
  return value?.kind === 'date' ? rfc3339(value.iso) : undefined;
}

export const googleEventCompiler = makeCompiler({
  type: 'event',
  unmet: (view) =>
    !view.roles.eventName || !view.roles.eventStart
      ? 'An event ticket needs an event name and a start time.'
      : undefined,
  build(ctx) {
    const { view } = ctx;
    const eventName = ctx.take('eventName');
    const name = eventName ? ctx.roleText('eventName') : undefined;
    if (!name) return 'An event ticket needs an event name.';
    // The title of an event ticket is the event name: the same field is not shown twice.
    if (ctx.role('title')?.kind === 'text' && ctx.roleText('title') === name) ctx.take('title');
    const nextDate = (
      view.events.find((e) => e.active && e.date) ?? view.events.find((e) => e.date)
    )?.date;
    const dateTime = {
      start: dateOf(ctx, 'eventStart') ?? (nextDate ? rfc3339(nextDate) : undefined),
      end: dateOf(ctx, 'eventEnd'),
      doorsOpen: dateOf(ctx, 'doorsOpen'),
    };
    const venueName = ctx.take('venueName') && ctx.roleText('venueName');
    const venueAddress = ctx.take('venueAddress') && ctx.roleText('venueAddress');
    const eventId = ctx.take('eventId') && ctx.roleText('eventId');
    const logo = logoOf(ctx, { ...LOGO, loss: 'omitted' });
    const wideLogo = wideLogoOf(ctx);
    const hero = heroOf(ctx);

    const seatInfo: NonNullable<GoogleEventObject['seatInfo']> = {};
    for (const role of SEAT_ROLES)
      if (ctx.take(role))
        seatInfo[role] = ctx.localized(role, ctx.roleText(role) ?? '', TEXT.title);
    const holder = ctx.take('ticketHolder') && ctx.roleText('ticketHolder');
    const number = ctx.take('ticketNumber') && ctx.roleText('ticketNumber');
    const confirmation = ctx.take('confirmationCode') && ctx.roleText('confirmationCode');
    const validFrom = ctx.take('validFrom');
    const validUntil = ctx.take('validUntil');
    const locations = locationsOf(ctx);
    dateLosses(ctx, true);
    const start = validFrom?.kind === 'date' ? validFrom.iso : undefined;
    const end = validUntil?.kind === 'date' ? validUntil.iso : undefined;
    const common = objectCommon(ctx, { start, end, events: true });

    const venue = {
      ...(venueName ? { name: ctx.localized('venueName', venueName, TEXT.line) } : {}),
      ...(venueAddress ? { address: ctx.localized('venueAddress', venueAddress, TEXT.line) } : {}),
    };
    const times = Object.fromEntries(Object.entries(dateTime).filter(([, v]) => v !== undefined));
    const classBody: GoogleEventClass = {
      ...typedClass(ctx, hero),
      eventName: ctx.localized('eventName', name, TEXT.line),
      ...(Object.keys(venue).length > 0 ? { venue } : {}),
      ...(Object.keys(times).length > 0 ? { dateTime: times } : {}),
      ...(eventId ? { eventId: ctx.identity('eventId', eventId, IDENTITY) } : {}),
      ...(logo ? { logo } : {}),
      ...(wideLogo ? { wideLogo } : {}),
    };
    const objectBody: GoogleEventObject = {
      ...(holder ? { ticketHolderName: ctx.display('ticketHolder', holder, TEXT.title) } : {}),
      ...(number ? { ticketNumber: ctx.identity('ticketNumber', number, IDENTITY) } : {}),
      ...(confirmation
        ? {
            reservationInfo: {
              confirmationCode: ctx.identity('confirmationCode', confirmation, IDENTITY),
            },
          }
        : {}),
      ...(Object.keys(seatInfo).length > 0 ? { seatInfo } : {}),
      ...(locations ? { locations } : {}),
      ...common,
    };
    return { classBody, objectBody };
  },
});
