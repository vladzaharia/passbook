import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passes.update('0193a1b2-7c00-7000-8000-0000000000c1', {
  input: {
    name: 'Ada Example',
    tier: 'Day pass',
    validUntil: '2027-01-31',
  },
  notify: true,
});
console.log(result);
