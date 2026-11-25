import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.connections.uploads.create({
  name: 'members.csv',
  content: 'Holder email,Name,Tier,Valid until,Member ID\nada@example.com,Ada Example,Day pass,2026-12-31,NW-1001\ngrace@example.com,Grace Okafor,Day pass,2026-12-31,NW-1002\nalan@example.com,Alan Reyes,Day pass,2027-01-15,NW-1003\nmei@example.com,Mei Tanaka,Day pass,2026-12-31,NW-1004\nchris.example.com,Chris Dalton,Day pass,2026-12-31,NW-1005\n',
  encoding: 'utf8',
});
console.log(result);
