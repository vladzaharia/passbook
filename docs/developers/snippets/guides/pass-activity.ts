import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

for await (const event of pb.passes.activity.list('0193a1b2-7c00-7000-8000-0000000000c1')) {
  console.log(event.kind, event.at);
}
