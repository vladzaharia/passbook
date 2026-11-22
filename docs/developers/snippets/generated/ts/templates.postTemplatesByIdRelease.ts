import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.templates.releases.release('0193a1b2-7c00-7000-8000-0000000000b1', {
  version: '4',
  expected: {
    live: 2,
    test: 3,
  },
});
console.log(result);
