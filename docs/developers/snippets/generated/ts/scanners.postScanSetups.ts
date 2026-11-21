import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.scanSetups.create({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  name: 'Example',
  timeZone: 'Europe/Berlin',
});
console.log(result);
