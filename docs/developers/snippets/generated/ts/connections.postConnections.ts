import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.connections.create({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  connectorType: 'csv-url',
  name: 'Booking sheet',
  config: {
    url: 'https://docs.google.com/spreadsheets/d/e/2PACX-northwind-bookings/pub?output=csv',
    idColumn: 'Booking ID',
  },
  mapping: {
    name: {
      from: '/Name',
    },
    tier: {
      from: '/Plan',
    },
    validUntil: {
      from: '/Valid until',
    },
  },
  defaultTemplateId: '0193a1b2-7c00-7000-8000-0000000000b1',
  holderEmailField: '/Email',
  mode: 'poll',
});
console.log(result);
