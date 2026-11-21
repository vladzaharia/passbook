import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

for await (const template of pb.templates.list()) {
  console.log(template.id, template.name);
}
