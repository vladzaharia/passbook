import { calcomBookingsSetup } from './calcom-bookings.setup.ts';
import { first, HOUR_MS, ignored, isoMs, obj, type Recipe, record, ref, str } from './shared.ts';

const STATUS: Record<string, string> = {
  BOOKING_CREATED: 'created',
  BOOKING_RESCHEDULED: 'created',
  BOOKING_CANCELLED: 'cancelled',
  BOOKING_REJECTED: 'rejected',
  BOOKING_PAID: 'paid',
  BOOKING_REQUESTED: 'requested',
};
/** Only a confirmed booking may open a pass; a request waits for its confirmation. */
const CREATES = ['BOOKING_CREATED', 'BOOKING_PAID', 'BOOKING_RESCHEDULED'];

export const calcomBookings: Recipe = {
  id: 'calcom-bookings',
  label: 'Cal.com bookings',
  category: 'bookings',
  verifier: 'calcom',
  topicHeader: null,
  idPrefix: 'calcom',
  windowMs: HOUR_MS,
  topics: Object.keys(STATUS),
  pasteSecret: false,
  secretOrigin: 'passbook',
  secretScope: 'connection',
  line: 'Booking to pass. Voids when cancelled or moved.',
  setup: calcomBookingsSetup,
  outputFields: {
    title: { type: 'string' },
    startTime: { type: 'date' },
    endTime: { type: 'date' },
    timeZone: { type: 'string' },
    attendeeName: { type: 'string' },
    attendeeEmail: { type: 'string' },
    organizerName: { type: 'string' },
    location: { type: 'string' },
    eventType: { type: 'string' },
    status: { type: 'string' },
  },
  mapping: {
    title: { from: '/title' },
    startsAt: { from: '/startTime' },
    name: { from: '/attendeeName' },
    location: { from: '/location' },
  },
  holderEmailField: '/attendeeEmail',
  voidWhen: [{ from: '/status', op: 'in', values: ['cancelled', 'rejected', 'rescheduled'] }],
  adapt({ body }) {
    const o = obj(body);
    const type = str(o?.triggerEvent);
    const payload = obj(o?.payload);
    const created = isoMs(o?.createdAt);
    const uid = ref(payload?.uid);
    // MEETING_STARTED and a custom payload template have no booking envelope.
    if (!o || !payload || type === null || created === null || !uid)
      return ignored('unrecognized_shape');
    const status = STATUS[type];
    if (!status) return ignored('unknown_type');
    const attendee = first(payload.attendees);
    const organizer = obj(payload.organizer);
    const refs = [uid];
    const records = {
      [uid]: record({
        title: str(payload.title),
        startTime: str(payload.startTime),
        endTime: str(payload.endTime),
        timeZone: str(organizer?.timeZone),
        attendeeName: str(attendee?.name),
        attendeeEmail: str(attendee?.email),
        organizerName: str(organizer?.name),
        location: str(payload.location),
        eventType: str(payload.type),
        status,
      }),
    };
    // A reschedule opens a new booking uid (payload.uid) and carries the old one in payload.rescheduleUid:
    // https://github.com/calcom/cal.com/blob/main/packages/features/bookings/lib/service/RegularBookingService.ts
    // (webhookData, `rescheduleUid`), wrapped by packages/features/webhooks/lib/sendPayload.ts.
    const old = ref(payload.rescheduleUid);
    if (type === 'BOOKING_RESCHEDULED' && old && old !== uid) {
      refs.push(old);
      records[old] = record({ status: 'rescheduled' });
    }
    return {
      refs,
      records,
      versions: Object.fromEntries(refs.map((r) => [r, created])),
      createRefs: CREATES.includes(type) ? [uid] : [],
      signedAt: created,
    };
  },
};
