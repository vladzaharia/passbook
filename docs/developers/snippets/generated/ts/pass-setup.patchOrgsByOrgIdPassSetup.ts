import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.orgs.updatePassSetup('0193a1b2-7c00-7000-8000-0000000000a1', {
  expectedRevision: '4',
  brand: {
    name: 'Northwind Climbing',
    logo: {
      sha: 'd5d705ca576254bf7ea60c287f5c830178058ba455a678d68b7874cdff9a9d8e',
      version: 'b78bdcd5b6412c478d2a89e1c1296e3d617e3323c1c49c7d2c2bd73396dad792',
    },
  },
  channels: {
    mobile: 'allowed',
    apple: 'allowed',
  },
});
console.log(result);
