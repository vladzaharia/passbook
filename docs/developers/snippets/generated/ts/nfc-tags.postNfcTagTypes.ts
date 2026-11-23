import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.nfc.tagTypes.create({
  name: 'Member wristband',
  use: 'member',
  scopes: 'pass',
  perPass: 1,
});
console.log(result);
