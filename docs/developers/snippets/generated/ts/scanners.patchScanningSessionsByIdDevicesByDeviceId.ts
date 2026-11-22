import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.scanningSessions.devices.update('0193a1b2-7c00-7000-8000-0000000000e1', '0193a1b2-7c00-7000-8000-0000000000e1', {
  name: 'Front desk',
  surface: 'auto',
  overrides: {
    flow: 'auto',
    reader: 'none',
  },
});
console.log(result);
