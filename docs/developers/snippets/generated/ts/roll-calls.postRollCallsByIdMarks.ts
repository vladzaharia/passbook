import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.rollCalls.mark('0193a1b2-7c00-7000-8000-0000000000e1', {
  marks: [
    {
      rollCallId: '0193a1b2-7c00-7000-8000-0000000000a1',
      passId: '0193a1b2-7c00-7000-8000-0000000000a2',
      status: 'present',
      at: 1764000000000,
    },
  ],
});
console.log(result);
