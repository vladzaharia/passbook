import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });
const orgId = '0193a1b2-7c00-7000-8000-0000000000a1';

// The revision from the read: a stale one is 409 PASS_SETUP_CHANGED.
const { revision } = await pb.orgs.retrievePassSetup(orgId);
const plan = await pb.orgs.updatePassSetup(
  orgId,
  {
    expectedRevision: revision,
    brand: {
      passColors: { background: '#0f172a', foreground: '#ffffff', label: '#fbbf24' },
    },
  },
  { query: { dryRun: 'true' } },
);

console.log(plan.diff, plan.impact, plan.view.checks);
