import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passes.create({
  templateId: '0193a1b2-7c00-7000-8000-0000000000b1',
  input: {
    eventName: 'Friday Night Bouldering',
    venueName: 'Northwind Climbing',
    venueRegion: 'Seattle, WA',
    startsAt: '2026-12-04T18:00:00-08:00',
    endsAt: '2026-12-04T22:00:00-08:00',
    attendee: 'Ada Example',
    ticketId: 'NW-1001',
  },
  holderEmail: 'ada@example.com',
  externalId: 'booking_8841',
  sendEmail: true,
});
console.log(result);
