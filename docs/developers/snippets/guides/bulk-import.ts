import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const csv = [
  'attendee,ticket,email',
  'Ada Example,TICKET-1001,ada@example.com',
  'Grace Host,TICKET-1002,grace@example.com',
].join('\n');

const draft = await pb.passImports.create({
  templateId: '0193a1b2-7c00-7000-8000-0000000000b1',
  source: { kind: 'file', name: 'guests.csv', csv },
});

// Check reports every row that would fail, before anything is made.
const checked = await pb.passImports.check(draft.id, {
  plan: {
    mapping: {
      attendee: { from: 'attendee' },
      ticketId: { from: 'ticket' },
      eventName: { from: 'attendee', transform: { kind: 'constant', options: { value: 'Harbor Night' } } },
      venueName: { from: 'attendee', transform: { kind: 'constant', options: { value: 'Harbor Hall' } } },
      venueRegion: { from: 'attendee', transform: { kind: 'constant', options: { value: 'Cupertino, CA' } } },
      startsAt: { from: 'attendee', transform: { kind: 'constant', options: { value: '2030-06-01T19:00:00-07:00' } } },
      endsAt: { from: 'attendee', transform: { kind: 'constant', options: { value: '2030-06-01T22:00:00-07:00' } } },
    },
    holderEmail: { from: 'email' },
    externalId: { from: 'ticket' },
    match: 'externalId',
  },
});
console.log(checked);

// Commit runs in the background. Read the import again to follow it.
await pb.passImports.commit(draft.id, { skipInvalid: true });
const status = await pb.passImports.retrieve(draft.id);
console.log(status.state);
