import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// Both secrets sign for 24 hours. The new secret is shown once.
const result = await pb.webhookEndpoints.rotateSecret('0193a1b2-7c00-7000-8000-0000000000e1', { overlapHours: 24 });
console.log(result.secret);
