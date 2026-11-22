import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const plan = await pb.scanningSessions.setup(
  {
    orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
    preset: 'venue',
    doors: [
      {
        name: 'Main door',
        admits: { templateIds: ['0193a1b2-7c00-7000-8000-0000000000b1'] },
      },
    ],
  },
  { query: { dryRun: 'true' } },
);

console.log(plan);
