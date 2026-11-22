import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.connections.testConfig({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  connectorType: 'google-sheets',
  config: {
    sheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
    range: 'Members!A:E',
  },
  secrets: {
    sheetsToken: 'ya29.07b655bbd0c4f2a4a40f18285549a2a81d813168',
  },
  mapping: {
    name: {
      from: 'Name',
    },
    tier: {
      from: 'Tier',
    },
    validUntil: {
      from: 'Valid until',
    },
  },
  voidWhen: [
    {
      from: 'Booking sheet',
      op: 'in',
      values: [
        'Day pass',
      ],
    },
  ],
});
console.log(result);
