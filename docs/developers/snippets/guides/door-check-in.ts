import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// A terminal key names its device on every call.
const headers = { 'x-passbook-device': 'door-1' };
const input = { code: 'PB-4F7K-92QX', method: 'camera' as const };

const seen = await pb.terminal.resolve(
  { idempotencyKey: crypto.randomUUID(), input, clientTs: Date.now() },
  { headers },
);
console.log(seen);

const admitted = await pb.terminal.act(
  { idempotencyKey: crypto.randomUUID(), input, clientTs: Date.now(), actionId: 'auto' },
  { headers },
);
console.log(admitted);
