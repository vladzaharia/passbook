import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.visitors.create({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  name: 'Ada Example',
  hostName: 'Grace Host',
  hostEmail: 'grace@example.com',
  windowFrom: 1764000000000,
  windowUntil: 1764086400000,
});
console.log(result);
