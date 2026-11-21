import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passes.matchPhotos({
  keys: [
    'Example',
  ],
});
console.log(result);
