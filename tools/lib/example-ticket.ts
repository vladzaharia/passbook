// The template every pass example draws from: the sandbox's Quickstart ticket (templates/starter-event-ticket) with
// Northwind values, so a reader's first Run and copied sample pass the template's own input schema.
const ORG = 'Northwind Climbing';
const SERIAL = '0193a1b2-7c00-7000-8000-0000000000c2';

/** `input` for POST /passes: the ticket's required inputs. */
export const TICKET_INPUT = {
  eventName: 'Friday Night Bouldering',
  venueName: 'Northwind Climbing',
  venueRegion: 'Seattle, WA',
  startsAt: '2026-12-04T18:00:00-08:00',
  endsAt: '2026-12-04T22:00:00-08:00',
  attendee: 'Ada Example',
  ticketId: 'NW-1001',
};

const text = (title: string, maxLength: number) => ({
  type: 'string',
  title,
  minLength: 1,
  maxLength,
});
const when = (title: string) => ({ type: 'string', title, format: 'date-time' });

/** `GET /templates/{id}/input-schema`: the ticket's required inputs and the optional ones the examples use. */
export const TICKET_INPUT_SCHEMA = {
  type: 'object',
  required: ['eventName', 'venueName', 'venueRegion', 'startsAt', 'endsAt', 'attendee', 'ticketId'],
  additionalProperties: false,
  properties: {
    eventName: text('Event', 80),
    venueName: text('Venue', 80),
    venueRegion: text('City', 80),
    venueRoom: { type: 'string', title: 'Room', minLength: 1, maxLength: 60 },
    startsAt: when('Starts'),
    endsAt: when('Ends'),
    doorsAt: when('Doors'),
    attendee: text('Attendee', 80),
    admission: { type: 'string', title: 'Admission', maxLength: 40, default: 'General' },
    seat: { type: 'string', title: 'Seat', maxLength: 40 },
    ticketId: text('Ticket ID', 64),
  },
};

export const TICKET = {
  slug: 'quickstart-ticket',
  name: 'Quickstart ticket',
  description: 'A ticket for a climbing night, scanned at the front desk.',
  /** The pass's own title and subtitle: the event and the attendee. */
  title: TICKET_INPUT.eventName,
  sample: TICKET_INPUT,
  fieldSources: Object.fromEntries(Object.keys(TICKET_INPUT).map((k) => [k, 'manual'])),
  inputSchema: TICKET_INPUT_SCHEMA,
  passJson: {
    formatVersion: 1,
    passTypeIdentifier: 'pass.mobile.passbook.northwind',
    serialNumber: SERIAL,
    organizationName: ORG,
    description: 'Quickstart ticket',
    backgroundColor: 'rgb(17, 42, 74)',
    foregroundColor: 'rgb(255, 255, 255)',
    labelColor: 'rgb(255, 196, 0)',
    eventTicket: {
      primaryFields: [{ key: 'event', label: 'Event', value: TICKET_INPUT.eventName }],
      secondaryFields: [
        { key: 'venue', label: 'Venue', value: TICKET_INPUT.venueName },
        { key: 'starts', label: 'Starts', value: TICKET_INPUT.startsAt },
      ],
      auxiliaryFields: [{ key: 'attendee', label: 'Attendee', value: TICKET_INPUT.attendee }],
    },
  },
};
