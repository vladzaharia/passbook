import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.nfc.keysets.create({
  name: 'Staff badges',
  generate: true,
});
console.log(result);
