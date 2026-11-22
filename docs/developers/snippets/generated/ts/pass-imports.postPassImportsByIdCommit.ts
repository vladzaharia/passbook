import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passImports.commit('0193a1b2-7c00-7000-8000-0000000000e1', {
  skipInvalid: false,
  email: {
    send: 'held',
    holdMs: 300000,
  },
});
console.log(result);
