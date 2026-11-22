import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.connections.testConfig({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  connectorType: 'csv-url',
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
});
console.log(result);
