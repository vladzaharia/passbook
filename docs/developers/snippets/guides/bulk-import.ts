import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const csv = [
  'attendee,ticket,email',
  'Ada Example,TICKET-1001,ada@example.com',
  'Grace Host,TICKET-1002,grace@example.com',
  'Alan Guest,TICKET-1003,alan@example.com',
  'Edsger Visitor,TICKET-1004,edsger@example.com',
  'Barbara Member,TICKET-1005,barbara@example.com',
].join('\n');

// Nothing is made yet. Keep draft.id for the check and commit calls.
const draft = await pb.passImports.create({
  templateId: '0193a1b2-7c00-7000-8000-0000000000b1',
  source: { kind: 'file', name: 'guests.csv', csv },
});
console.log(draft.id, draft.state);
