import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.connections.testConfig({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  connectorType: 'example',
  config: {
    example: {},
  },
  secrets: {
    example: 'example',
  },
  mapping: {
    example: {
      from: 'example',
      transform: {
        kind: 'enum',
        options: {
          example: {},
        },
      },
    },
  },
});
console.log(result);
