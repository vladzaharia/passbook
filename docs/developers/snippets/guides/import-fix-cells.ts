import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const csv = [
  'Holder email,Event,Venue,City,Starts,Ends,Attendee,Ticket ID',
  'ada@example.com,Harbor Night,Harbor Hall,"Cupertino, CA",2030-06-01T19:00:00-07:00,2030-06-01T22:00:00-07:00,Ada Example,TICKET-1001',
  'grace@example.com,Harbor Night,Harbor Hall,"Cupertino, CA",TBD,2030-06-01T22:00:00-07:00,Grace Host,TICKET-1002',
  'alan@example.com,Harbor Night,Harbor Hall,"Cupertino, CA",2030-06-01T19:00:00-07:00,2030-06-01T22:00:00-07:00,Alan Guest,TICKET-1003',
].join('\n');

const draft = await pb.passImports.create({
  templateId: '0193a1b2-7c00-7000-8000-0000000000b1',
  source: { kind: 'file', name: 'guests.csv', csv },
  mapping: 'auto',
});
if (!draft.plan) throw new Error('Map the columns first.');

// Row 3 is spreadsheet row 3: the header is row 1. The key is the column pointer.
const fixed = await pb.passImports.check(draft.id, {
  plan: { ...draft.plan, overrides: { '3': { '/Starts': '2030-06-01T19:00:00-07:00' } } },
});
console.log(fixed.counts);
