import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

for await (const item of pb.templateImports.list({
  limit: 20,
})) console.log(item);
