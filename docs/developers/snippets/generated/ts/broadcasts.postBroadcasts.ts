import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.broadcasts.create({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  kind: 'message',
  name: 'Doors open',
  target: {
    templateIds: [
      '0193a1b2-7c00-7000-8000-0000000000b1',
    ],
  },
  patch: {
    message: 'Doors open at 6 PM.',
  },
  send: 'draft',
});
console.log(result);
