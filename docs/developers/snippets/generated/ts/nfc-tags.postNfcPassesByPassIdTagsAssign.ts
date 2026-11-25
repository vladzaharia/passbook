import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.nfc.tags.assign('0193a1b2-7c00-7000-8000-0000000000c1', {
  id: '0193a1b2-7c00-7000-8000-000000000082',
  format: 'hex',
  binding: 'pass',
  label: 'Wristband 14',
});
console.log(result);
