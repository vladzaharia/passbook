import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// A scan's idempotencyKey is a UUID with version digit 7: a random UUID with its 15th character set to 7.
const key = crypto.randomUUID().replace(/^(.{14})4/, '$17');

const answer = await pb.terminal.resolve(
  {
    idempotencyKey: key,
    input: { passId: '0193a1b2-7c00-7000-8000-0000000000c1', method: 'manual' },
    clientTs: Date.now(),
  },
  { headers: { 'x-passbook-device': 'sandbox' } },
);
console.log(answer.kind, answer.reason);
