import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.apiKeys.retire('0193a1b2-7c00-7000-8000-0000000000e1', {
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  retireAt: 1764090000000,
});
console.log(result);
