import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

for await (const item of pb.auditEntries.list({
  from: 1794000000000,
  limit: 25,
})) console.log(item);
