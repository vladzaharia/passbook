import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.terminal.act({
  idempotencyKey: '0193a1b2-7c00-7000-8000-000000000f02',
  input: {
    code: 'PB-4F7K-92QX',
    method: 'camera',
  },
  clientTs: 1764000000000,
  actionId: 'auto',
}, { headers: {
    'x-passbook-device': 'door-1',
  } });
console.log(result);
