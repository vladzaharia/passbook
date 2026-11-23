import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.brand.update({
  accent: '#ffc400',
  mark: 'full',
  configRevision: 3,
});
console.log(result);
