import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const run = await pb.broadcasts.retrieve('0193a1b2-7c00-7000-8000-0000000000e1');
// A run that is still sending cannot be undone: stop it, then undo once it ends.
if (run.state === 'sending') await pb.broadcasts.stop(run.id);

const undo = await pb.broadcasts.undo(run.id);
console.log(undo.id, undo.restorable, undo.kept);
