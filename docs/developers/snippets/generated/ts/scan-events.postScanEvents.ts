import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.scanEvents.create({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  name: 'Saturday gala',
  templateIds: [
    '0193a1b2-7c00-7000-8000-0000000000b1',
  ],
  opensAt: 1795129200000,
  closesAt: 1795212000000,
  timeZone: 'Europe/Berlin',
});
console.log(result);
