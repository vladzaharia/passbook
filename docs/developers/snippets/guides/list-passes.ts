import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// The loop fetches the next page when this one runs out.
for await (const pass of pb.passes.list({ status: 'active', limit: 100 })) {
  console.log(pass.id, pass.title);
}
