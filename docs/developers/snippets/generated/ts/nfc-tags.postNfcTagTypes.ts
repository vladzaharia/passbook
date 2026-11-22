import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.nfc.tagTypes.create({
  name: 'Wristband 14',
  use: 'member',
  scopes: 'pass',
  perPass: 3,
  bindingDays: 3,
});
console.log(result);
