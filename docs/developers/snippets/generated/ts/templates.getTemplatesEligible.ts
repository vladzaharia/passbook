import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

for await (const item of pb.templates.listEligible({
  mode: 'test',
  provider: 'apple',
  limit: 25,
})) console.log(item);
