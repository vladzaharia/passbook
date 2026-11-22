import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.webhookEndpoints.deliveries.bulkReplay('0193a1b2-7c00-7000-8000-0000000000e1', {
  from: 23,
  to: 39,
  include: 'failed',
  missing: false,
  dryRun: false,
});
console.log(result);
