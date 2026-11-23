import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

for await (const item of pb.visitors.list({
  dayStart: 1764000000000,
  dayEnd: 1764086400000,
})) console.log(item);
