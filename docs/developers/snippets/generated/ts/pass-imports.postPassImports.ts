import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passImports.create({
  templateId: '0193a1b2-7c00-7000-8000-0000000000b1',
  source: {
    kind: 'file',
    name: 'Example',
    csv: 'Example',
  },
});
console.log(result);
