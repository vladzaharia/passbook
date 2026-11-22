import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.scanningSessions.setup({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  preset: 'front_desk',
  timeZone: 'America/Los_Angeles',
  places: [
    {
      zoneId: '0193a1b2-7c00-7000-8000-000000000081',
    },
  ],
  doors: [
    {
      name: 'Front desk',
      place: 'main-hall',
      admits: {
        any: true,
      },
      hours: 'always',
    },
  ],
});
console.log(result);
