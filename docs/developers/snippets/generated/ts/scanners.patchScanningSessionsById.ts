import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.scanningSessions.update('0193a1b2-7c00-7000-8000-0000000000e1', {
  name: 'Day pass',
  timeZone: 'America/Los_Angeles',
  accepts: {
    templateIds: [
      '0193a1b2-7c00-7000-8000-0000000000b1',
    ],
    eventIds: [
      '0193a1b2-7c00-7000-8000-0000000000e1',
    ],
  },
});
console.log(result);
