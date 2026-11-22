import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.brand.update({
  accent: '#1a73e8',
  mark: 'full',
});
console.log(result);
