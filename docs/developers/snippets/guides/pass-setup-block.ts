import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// expectedRevision is the revision you read above.
const plan = await pb.orgs.updatePassSetup(
  '0193a1b2-7c00-7000-8000-0000000000a1',
  { expectedRevision: 'r1', channels: { mobile: 'blocked' } },
  { query: { dryRun: 'true' } },
);

console.log(plan.impact.channelStops);
