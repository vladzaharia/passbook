import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

for await (const message of pb.testEmails.list()) console.log(message.to, message.subject);
