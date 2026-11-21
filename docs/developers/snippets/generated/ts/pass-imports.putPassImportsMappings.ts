import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passImports.mappings.save({
  templateId: '0197f1c2-6f3a-7b11-9c1e-2a5d4c8e9b10',
  name: 'Gym export',
  columns: [
    'Member #',
    'Name',
    'Holder email',
  ],
  plan: {
    mapping: {
      memberName: {
        from: '/Name',
      },
    },
    holderEmail: {
      from: '/Holder email',
    },
    externalId: {
      from: '/Member #',
    },
    match: 'externalId',
    keepManual: false,
    save: true,
  },
});
console.log(result);
