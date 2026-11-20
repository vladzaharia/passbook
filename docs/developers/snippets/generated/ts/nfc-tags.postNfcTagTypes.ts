import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.nfc.tagTypes.create({
  name: 'Example',
  use: 'member',
});
console.log(result);
