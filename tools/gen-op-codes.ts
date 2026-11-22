// Writes docs/api/operation-codes.json: the error codes each route can reach. Run via `npm run gen`
// (after gen-error-catalog); check-developers fails when the file drifts.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { knownCodes, opCodesFile } from './lib/op-codes.ts';

writeFileSync(
  resolve(import.meta.dirname, '../docs/api/operation-codes.json'),
  opCodesFile(knownCodes()),
);
