import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.webhookEndpoints.ensureCapture({
  eventTypes: [
    'pass.issued',
    'pass.scanned',
  ],
});
console.log(result);
