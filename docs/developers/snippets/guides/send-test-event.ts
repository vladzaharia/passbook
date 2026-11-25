import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.webhookEndpoints.sendTest('0193a1b2-7c00-7000-8000-0000000000e1', { type: 'pass.issued' });
// captureId names the stored request.
console.log(result.captureId);
