import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.bulkRuns.start({
  action: 'void',
  selection: {
    filter: {
      status: 'active',
    },
    expectCount: 442,
  },
});
console.log(result);
