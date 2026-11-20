import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passes.bulkReissue({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  templateId: '0193a1b2-7c00-7000-8000-0000000000b1',
  cause: 'template_upgrade',
});
console.log(result);
