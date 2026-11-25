// Reads a stored capture and checks its signature. Set PASSBOOK_KEY, PASSBOOK_ENDPOINT_ID,
// PASSBOOK_CAPTURE_ID and PASSBOOK_WEBHOOK_SECRET. A stored capture is old, so there is no timestamp check.
import { env } from 'node:process';

const res = await fetch(
  `https://passbook.mobile/api/v1/webhook-endpoints/${env.PASSBOOK_ENDPOINT_ID}/captures/${env.PASSBOOK_CAPTURE_ID}`,
  { headers: { authorization: `Bearer ${env.PASSBOOK_KEY}` } },
);
const capture = (await res.json()) as { body: string; headers: Record<string, string> };

const key = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(env.PASSBOOK_WEBHOOK_SECRET ?? ''),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign'],
);
const mac = await crypto.subtle.sign(
  'HMAC',
  key,
  new TextEncoder().encode(`${capture.headers['x-passbook-timestamp']}.${capture.body}`),
);
const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
console.log(capture.headers['x-passbook-signature']?.includes(`v1=${hex}`) ? 'verified' : 'no match');
