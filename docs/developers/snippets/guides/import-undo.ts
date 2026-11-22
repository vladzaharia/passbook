import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

// Within 24 hours of the end. Passes edited or scanned since are kept and listed.
const undo = await pb.passImports.undo('0193a1b2-7c00-7000-8000-0000000000e1', {});
console.log(undo.state, undo.removed, undo.restored, undo.kept);
