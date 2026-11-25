import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// The scanId is in the admit answer. Undo works only while undoUntil is in the future.
const scanId = process.env.PASSBOOK_SCAN_ID ?? '';
const key = crypto.randomUUID().replace(/^(.{14})4/, '$17');

const answer = await pb.terminal.scans.undo(
  scanId,
  { idempotencyKey: key },
  { headers: { 'x-passbook-device': 'sandbox' } },
);
console.log(answer.kind);
