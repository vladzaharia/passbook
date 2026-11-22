import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.scanners.setMode('0193a1b2-7c00-7000-8000-0000000000e1', {
  mode: 'test',
  detachEvent: false,
});
console.log(result);
