import { PassBook } from '@passbook/sdk';

// A scan's idempotencyKey is a UUIDv7.
function uuidv7(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) & 0xff;
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// A terminal key names its device on every call. In a sandbox, `sandbox` names the Sandbox terminal.
const headers = { 'x-passbook-device': process.env.PASSBOOK_TERMINAL ?? 'sandbox' };
const input = { code: 'PB-4F7K-92QX', method: 'camera' as const };

const seen = await pb.terminal.resolve(
  { idempotencyKey: uuidv7(), input, clientTs: Date.now() },
  { headers },
);
console.log(seen);

const admitted = await pb.terminal.act(
  { idempotencyKey: uuidv7(), input, clientTs: Date.now(), actionId: 'auto' },
  { headers },
);
console.log(admitted);
