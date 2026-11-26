import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.connections.preview('0193a1b2-7c00-7000-8000-0000000000e1', {
  arrivalId: '0193a1b2-7c00-7000-8000-f3168e33f525',
});
console.log(result);
