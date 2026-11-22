import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.bundles.create({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  passIds: [
    '0193a1b2-7c00-7000-8000-0000000000a2',
  ],
  name: 'Ada Example',
  holderEmail: 'ada@example.com',
  sendEmail: false,
});
console.log(result);
