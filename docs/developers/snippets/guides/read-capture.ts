import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const capture = await pb.webhookEndpoints.captures.retrieve('0193a1b2-7c00-7000-8000-0000000000e1', '0193a1b2-7c00-7000-8000-0000000000e2');
console.log(capture.headers, capture.body);
