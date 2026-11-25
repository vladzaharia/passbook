import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.broadcasts.countRecipients({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  target: {
    templateIds: [
      '0193a1b2-7c00-7000-8000-0000000000b1',
    ],
  },
  patch: {
    endsAt: '2026-12-04T23:00:00-08:00',
  },
  notify: true,
});
console.log(result);
