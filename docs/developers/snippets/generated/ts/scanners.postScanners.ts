import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.scanners.create({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  name: 'Front desk',
  kind: 'device',
  accepts: {
    eventId: '0193a1b2-7c00-7000-8000-0000000000e1',
  },
  settings: {
    checkIn: {
      mode: 'single',
      eventId: '0193a1b2-7c00-7000-8000-0000000000e1',
    },
    direction: 'in',
  },
  timeZone: 'America/Los_Angeles',
});
console.log(result);
