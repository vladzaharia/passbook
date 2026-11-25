import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });
const orgId = '0193a1b2-7c00-7000-8000-0000000000a1';

const { revision } = await pb.orgs.retrievePassSetup(orgId);
// A retry with the same key replays the answer; a changed revision is 409 PASS_SETUP_CHANGED.
const saved = await pb.orgs.updatePassSetup(
  orgId,
  {
    expectedRevision: revision,
    brand: {
      passColors: { background: '#0f172a', foreground: '#ffffff', label: '#fbbf24' },
    },
  },
  { idempotencyKey: 'setup-harbor-hall-1' },
);

console.log(saved.view.checks.length === 0 ? 'Ready' : saved.view.checks);
