import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.webhookEndpoints.create({
  url: 'https://bookings.northwind.example.com/hooks/passbook',
  description: 'Front-desk check-in sync',
  eventTypes: [
    'pass.issued',
    'pass.scanned',
  ],
  templateIds: [
    '0193a1b2-7c00-7000-8000-0000000000b1',
  ],
});
console.log(result);
