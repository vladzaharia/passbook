import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// The newest change run is the one you just started. In your code, keep the id from the create call.
const { items } = await pb.broadcasts.list({ kind: 'change', limit: 1 });
const run = items[0];

// A run that is still sending cannot be undone. Wait for sent, or stop it with broadcasts.stop(run.id).
if (run?.state === 'sent') {
  const undo = await pb.broadcasts.undo(run.id);
  console.log(undo.id, undo.restorable, undo.kept);
} else console.log(run?.state);
