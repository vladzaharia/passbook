import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passViews.replace({
  items: [],
  revision: 0,
});
console.log(result);
