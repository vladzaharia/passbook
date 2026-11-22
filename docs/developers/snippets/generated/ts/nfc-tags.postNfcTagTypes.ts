import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.nfc.tagTypes.create({
  name: 'Northwind Climbing',
  use: 'member',
  scopes: 'pass',
  perPass: 4,
  bindingDays: 5,
});
console.log(result);
