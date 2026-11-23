import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

for await (const item of pb.templates.candidates.list('0193a1b2-7c00-7000-8000-0000000000b1', {
  mode: 'test',
  provider: 'apple',
})) console.log(item);
