import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.terminal.scans.undo('0193a1b2-7c00-7000-8000-0000000000e1', {
  idempotencyKey: '0193a1b2-7c00-7000-8000-000000000f03',
}, { headers: {
    'x-passbook-device': 'door-1',
  } });
console.log(result);
