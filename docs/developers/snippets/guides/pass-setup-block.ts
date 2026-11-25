import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });
const orgId = '0193a1b2-7c00-7000-8000-0000000000a1';

// expectedRevision is the revision you read. dryRun answers the plan and writes nothing.
const { revision } = await pb.orgs.retrievePassSetup(orgId);
const plan = await pb.orgs.updatePassSetup(
  orgId,
  { expectedRevision: revision, channels: { mobile: 'blocked' } },
  { query: { dryRun: 'true' } },
);

console.log(plan.impact.channelStops, plan.view.checks);
