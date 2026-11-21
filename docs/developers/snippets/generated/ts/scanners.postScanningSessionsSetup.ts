import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.scanningSessions.setup({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  preset: 'front_desk',
  places: [
    {
      ref: 'gym',
      name: 'Gym',
      max: 60,
    },
  ],
  staff: [
    {
      name: 'Maya Chen',
      role: 'manager',
    },
    {
      name: 'Sam Ortiz',
      role: 'desk',
    },
  ],
  doors: [
    {
      name: 'Front desk',
      place: 'gym',
      admits: {
        templateIds: [
          '0193a1b2-7c00-7000-8000-0000000000b1',
          '0193a1b2-7c00-7000-8000-0000000000b2',
        ],
      },
      hours: {
        every: [
          '06:00-22:00',
        ],
      },
    },
  ],
});
console.log(result);
