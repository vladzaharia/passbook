import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.webhookEndpoints.update('0193a1b2-7c00-7000-8000-0000000000e1', {
  url: 'https://hooks.example.com/passbook',
  description: '',
  eventTypes: [
    'pass.issued',
  ],
});
console.log(result);
