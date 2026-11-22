import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// A retry with the same key replays the answer: the same ids, no new PINs or codes.
const body = {
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  preset: 'venue' as const,
  doors: [
    {
      name: 'Main door',
      admits: { templateIds: ['0193a1b2-7c00-7000-8000-0000000000b1'] },
    },
  ],
};
const options = { idempotencyKey: 'setup-main-door-1' };

const made = await pb.scanningSessions.setup(body, options);
const again = await pb.scanningSessions.setup(body, options);

console.log(made);
console.log('replayed' in again && again.replayed);
