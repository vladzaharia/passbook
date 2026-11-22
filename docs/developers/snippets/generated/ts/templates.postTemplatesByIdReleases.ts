import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.templates.releases.create('0193a1b2-7c00-7000-8000-0000000000b1', {
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  mode: 'test',
  provider: 'apple',
  candidateId: '0193a1b2-7c00-7000-8000-000000000092',
  approvalId: '0193a1b2-7c00-7000-8000-e933a9c3efe1',
  candidateHash: '59e09797f3c21b80c9e720f02a4745530655087e12e1ef1103d9e389f12bf2b1',
  expectedGeneration: 3,
});
console.log(result);
