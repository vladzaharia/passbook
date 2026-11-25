import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const { secret } = await pb.webhookEndpoints.captures.revealSecret('0193a1b2-7c00-7000-8000-0000000000e1');
// Store it as PASSBOOK_WEBHOOK_SECRET.
console.log(secret);
