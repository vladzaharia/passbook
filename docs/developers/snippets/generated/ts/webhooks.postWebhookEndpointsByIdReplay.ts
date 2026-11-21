import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.webhookEndpoints.deliveries.bulkReplay('0193a1b2-7c00-7000-8000-0000000000e1', {
  from: 1764000000000,
  to: 1764003600000,
  include: 'failed',
  dryRun: true,
});
console.log(result);
