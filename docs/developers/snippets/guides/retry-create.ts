import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// The same key returns the first pass instead of making a second one.
const options = { idempotencyKey: 'order-8841' };
const body = {
    templateId: '0193a1b2-7c00-7000-8000-0000000000b1',
    externalId: 'order-8841',
    holderEmail: 'ada@example.com',
    input: {
      eventName: 'Harbor Night',
      venueName: 'Harbor Hall',
      venueRegion: 'Cupertino, CA',
      startsAt: '2030-06-01T19:00:00-07:00',
      endsAt: '2030-06-01T22:00:00-07:00',
      attendee: 'Ada Example',
      ticketId: 'TICKET-8841',
    },
  };

const first = await pb.passes.create(body, options);
const again = await pb.passes.create(body, options);

console.log(first.id === again.id);
