import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// Nothing changes. Samples show each pass's own values before and after.
const preview = await pb.broadcasts.countRecipients({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  target: {
    templateIds: ['0193a1b2-7c00-7000-8000-0000000000b1'],
    match: [{ input: 'venueName', values: ['Harbor Hall'] }],
  },
  patch: { venueName: { set: 'Pier 9' } },
  notify: false,
});
console.log(preview.targeted, preview.unchanged, preview.blocked, preview.samples);
