import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.holders.offboard({
  holderEmail: 'ada@example.com',
  passes: 'void',
  dryRun: true,
});
console.log(result);
