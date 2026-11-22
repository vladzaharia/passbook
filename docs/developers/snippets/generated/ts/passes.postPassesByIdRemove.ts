import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passes.remove('0193a1b2-7c00-7000-8000-0000000000c1', {
  message: 'The gym closes at 18:00 on 24 December.',
});
console.log(result);
