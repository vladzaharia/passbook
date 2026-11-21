import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

for await (const pass of pb.passes.list({ status: 'active', limit: 100 })) {
  console.log(pass.id, pass.title);
}
