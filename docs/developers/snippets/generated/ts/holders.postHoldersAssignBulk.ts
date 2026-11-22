import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.holders.bulkAssign({
  items: [
    {
      passId: '0193a1b2-7c00-7000-8000-0000000000c1',
      email: 'ada@example.com',
    },
    {
      passId: '0193a1b2-7c00-7000-8000-f3f85c24ee38',
      email: 'grace@example.com',
    },
  ],
});
console.log(result);
