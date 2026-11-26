import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

for await (const item of pb.operations.list({
  limit: 25,
})) console.log(item);
