import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const { endpoint, secret } = await pb.webhookEndpoints.create({
  url: 'https://example.com/passbook',
  eventTypes: ['pass.issued', 'pass.updated', 'pass.voided'],
});

// The secret is shown once. Store it as PASSBOOK_WEBHOOK_SECRET.
console.log(endpoint.id, secret);
