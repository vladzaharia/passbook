import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const target = {
  templateIds: ['0193a1b2-7c00-7000-8000-0000000000b1'],
  match: [{ input: 'venueName', values: ['Harbor Hall'] }],
};
const patch = { venueName: { set: 'Pier 9' } };

// Send the count the preview showed. The server counts again when the run starts.
const preview = await pb.broadcasts.countRecipients({ orgId: '0193a1b2-7c00-7000-8000-0000000000a1', target, patch, notify: false });
const run = await pb.broadcasts.create({
  orgId: '0193a1b2-7c00-7000-8000-0000000000a1',
  kind: 'change',
  name: 'Move to Pier 9',
  send: 'now',
  notify: false,
  target: { ...target, expectCount: preview.targeted },
  patch,
});
console.log(run.id, run.state);
