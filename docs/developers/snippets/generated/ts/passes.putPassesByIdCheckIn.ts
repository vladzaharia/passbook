import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passes.checkInRules.update('0193a1b2-7c00-7000-8000-0000000000c1', {
  rules: {
    mode: 'daily',
  },
});
console.log(result);
