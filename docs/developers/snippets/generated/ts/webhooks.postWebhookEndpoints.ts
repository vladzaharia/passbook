import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.webhookEndpoints.create({
  url: 'https://hooks.example.com/passbook',
  description: 'Order system',
  eventTypes: [
    'pass.issued',
    'pass.scanned',
  ],
});
console.log(result);
