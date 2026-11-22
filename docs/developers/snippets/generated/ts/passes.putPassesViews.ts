import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passViews.replace({
  items: [
    {
      id: 'northwind',
      name: 'Northwind Climbing',
      filter: {
        templateId: '0193a1b2-7c00-7000-8000-0000000000b1',
        connectionId: '0193a1b2-7c00-7000-8000-000000000051',
      },
    },
  ],
  revision: 3,
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
});
console.log(result);
