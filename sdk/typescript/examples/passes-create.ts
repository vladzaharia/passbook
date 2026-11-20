import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const pass = await pb.passes.create({
  templateId: process.env.PASSBOOK_TEMPLATE_ID ?? '',
  input: { name: 'Ada Example', seat: 'Row 4, seat 12' },
  holderEmail: 'ada@example.com',
});

console.log(pass.id, pass.publicUrl);
