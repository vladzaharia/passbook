import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passImports.check('0193a1b2-7c00-7000-8000-0000000000e1', {
  plan: {
    mapping: {},
    holderEmail: {
      from: 'Example',
    },
    externalId: {
      from: 'Example',
    },
    match: 'externalId',
  },
});
console.log(result);
