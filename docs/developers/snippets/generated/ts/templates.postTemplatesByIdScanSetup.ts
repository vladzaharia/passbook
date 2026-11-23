import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.templates.setUpScanning('0193a1b2-7c00-7000-8000-0000000000b1', {
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  timeZone: 'America/Los_Angeles',
});
console.log(result);
