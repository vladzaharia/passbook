import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.rollCalls.mark('0193a1b2-7c00-7000-8000-0000000000e1', {
  marks: [
    {
      rollCallId: '0193a1b2-7c00-7000-8000-000000000072',
      passId: '0193a1b2-7c00-7000-8000-0000000000c1',
      status: 'present',
      at: 12,
    },
  ],
});
console.log(result);
