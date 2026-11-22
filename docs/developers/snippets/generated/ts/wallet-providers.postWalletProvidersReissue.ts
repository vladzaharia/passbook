import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passes.reissueProviderCopies({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  provider: 'google',
  templateId: '0193a1b2-7c00-7000-8000-0000000000b1',
});
console.log(result);
