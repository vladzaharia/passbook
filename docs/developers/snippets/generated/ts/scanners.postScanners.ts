import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.scanners.create({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  name: 'Example',
  kind: 'device',
  accepts: {
    eventId: '0193a1b2-7c00-7000-8000-0000000000e1',
  },
  timeZone: 'Europe/Berlin',
});
console.log(result);
