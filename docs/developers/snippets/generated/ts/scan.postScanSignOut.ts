import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.terminal.signOutEverywhere({
  idempotencyKey: '0193a1b2-7c00-7000-8000-0000000000aa',
  passId: '0193a1b2-7c00-7000-8000-0000000000c1',
  tag: 'returned',
});
console.log(result);
