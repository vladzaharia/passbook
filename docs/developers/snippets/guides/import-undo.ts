import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// The import that has ended is the one to undo. In your code, keep the id from the create call.
const { items } = await pb.passImports.list();

// Within 24 hours of the end. Passes edited or scanned since are kept and listed.
const undo = await pb.passImports.undo(items.find((i) => i.state === 'done')?.id ?? '', {});
console.log(undo.state, undo.removed, undo.restored, undo.kept);
