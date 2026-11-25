import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.connections.uploads.create({
  name: 'Example',
  content: 'Example',
  encoding: 'utf8',
});
console.log(result);
