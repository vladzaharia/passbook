import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.apiKeys.rotateCurrent({
  overlapHours: 2,
});
console.log(result);
