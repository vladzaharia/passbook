import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passImports.create({
  templateId: '0193a1b2-7c00-7000-8000-0000000000b1',
  source: {
    kind: 'file',
    name: 'members.csv',
    csv: 'Holder email,Name,Tier,Valid until,Member ID\nada@example.com,Ada Example,Day pass,2026-12-31,NW-1001\ngrace@example.com,Grace Okafor,Day pass,2026-12-31,NW-1002\nalan@example.com,Alan Reyes,Day pass,2027-01-15,NW-1003\n',
  },
  mapping: 'auto',
});
console.log(result);
