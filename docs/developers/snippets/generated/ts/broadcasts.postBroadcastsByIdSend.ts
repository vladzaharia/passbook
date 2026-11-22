import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.broadcasts.send('0193a1b2-7c00-7000-8000-0000000000e1', {
  at: 3,
});
console.log(result);
