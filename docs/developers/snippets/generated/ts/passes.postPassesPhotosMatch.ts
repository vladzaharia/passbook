import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passes.matchPhotos({
  keys: [
    'NW-1001',
    'NW-1002',
  ],
});
console.log(result);
