import { PassBook } from '@passbook/sdk';

const pb = new PassBook({ apiKey: process.env.PASSBOOK_KEY ?? '' });

const result = await pb.brand.webLogo.upload({
  png: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR42mOQz3/9nxLMMGrAqAGjBgwXAwCBLngfV/beKAAAAABJRU5ErkJggg==',
});
console.log(result);
