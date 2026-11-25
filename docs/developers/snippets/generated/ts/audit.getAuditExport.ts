import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

await pb.auditEntries.export({
  from: 1794000000000,
});
