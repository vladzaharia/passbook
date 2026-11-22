import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.connections.update('0193a1b2-7c00-7000-8000-0000000000e1', {
  name: 'Booking sheet',
  config: {
    sheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
    range: 'Members!A:E',
  },
  secrets: {
    sheetsToken: 'ya29.fb90204b82135d002e703a9f596d0c121e293bc0',
  },
});
console.log(result);
