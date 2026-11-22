import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passImports.mappings.save({
  name: 'Day pass',
  columns: [
    'tier',
  ],
  plan: {
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
    holderEmail: {
      from: 'Booking sheet',
      transform: {
        kind: 'enum',
        options: {
          tier: {},
        },
      },
    },
    externalId: {
      from: 'Booking sheet',
      transform: {
        kind: 'enum',
        options: {
          tier: {},
        },
      },
    },
    match: 'externalId',
    keepManual: false,
    save: false,
  },
  templateId: '0193a1b2-7c00-7000-8000-0000000000b1',
});
console.log(result);
