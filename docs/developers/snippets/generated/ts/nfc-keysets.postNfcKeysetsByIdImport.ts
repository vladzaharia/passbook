import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.nfc.keysets.importTags('0193a1b2-7c00-7000-8000-0000000000e1', {
  csv: 'name,email,tier\nAda Example,ada@example.com,Day pass\n',
  dryRun: false,
});
console.log(result);
