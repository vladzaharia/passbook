// Moves docs/api/changelog/unreleased.json into <today>.json. The integration PR runs and commits it, so main holds stamped releases.
import { resolve } from 'node:path';
import { stampRelease } from './lib/changelog-files.ts';

const date = new Date().toISOString().slice(0, 10);
const n = stampRelease(resolve(import.meta.dirname, '..'), date);
console.log(
  n ? `changelog: ${n} entries stamped into ${date}.json` : 'changelog: nothing unreleased',
);
