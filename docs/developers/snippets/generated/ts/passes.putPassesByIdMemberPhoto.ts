import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.passes.memberPhoto.upload('0193a1b2-7c00-7000-8000-0000000000c1', {
  png: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR42mOQz3/9nxLMMGrAqAGjBgwXAwCBLngfV/beKAAAAABJRU5ErkJggg==',
});
console.log(result);
