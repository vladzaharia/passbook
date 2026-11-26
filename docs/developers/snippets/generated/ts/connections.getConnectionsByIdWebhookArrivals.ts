import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

for await (const item of pb.connections.webhookArrivals.list('0193a1b2-7c00-7000-8000-0000000000e1', {
  limit: 25,
})) console.log(item);
