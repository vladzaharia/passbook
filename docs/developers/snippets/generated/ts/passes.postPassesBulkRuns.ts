import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.bulkRuns.start({
  action: 'remove',
  message: 'Your day pass was replaced by a monthly membership.',
  selection: {
    filter: {
      templateId: '0193a1b2-7c00-7000-8000-0000000000b1',
      status: 'active',
    },
    expectCount: 128,
  },
});
console.log(result);
