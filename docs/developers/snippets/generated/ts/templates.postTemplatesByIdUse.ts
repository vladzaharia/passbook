import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.blueprints.use('baked:starter-event-ticket', {
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  name: 'Ada Example',
  version: {
    passJson: {
      example: {},
    },
    manifest: {
      example: {},
    },
    assets: [
      {
        name: 'Ada Example',
        sha1: '0123456789abcdef0123456789abcdef01234567',
      },
    ],
  },
  baseVersion: 'example',
});
console.log(result);
