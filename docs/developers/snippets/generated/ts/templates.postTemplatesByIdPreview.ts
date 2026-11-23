import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.templates.preview('0193a1b2-7c00-7000-8000-0000000000b1', {
  version: '3',
  input: {
    name: 'Ada Example',
    tier: 'Day pass',
    validUntil: '2026-12-31',
  },
});
console.log(result);
