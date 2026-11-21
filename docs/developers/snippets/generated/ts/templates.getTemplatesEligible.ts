import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.templates.listEligible({
  mode: 'test',
  provider: 'apple',
});
console.log(result);
