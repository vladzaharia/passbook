import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.orgs.updatePassSetup('0193a1b2-7c00-7000-8000-0000000000a1', {
  expectedRevision: 'r1',
  brand: {
    logo: {
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    passColors: {
      background: '#0f172a',
      foreground: '#ffffff',
      label: '#fbbf24',
    },
  },
});
console.log(result);
