import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.templates.candidates.approve('0193a1b2-7c00-7000-8000-0000000000b1', '0193a1b2-7c00-7000-8000-0000000000e1', {
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  mode: 'test',
  provider: 'apple',
  candidateHash: 'Example',
});
console.log(result);
