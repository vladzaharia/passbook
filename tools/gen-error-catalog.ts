// Writes docs/api/errors.json and docs/api/webhook-events.json. Run via `npm run gen`; check-developers fails when they drift.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildErrorCatalogFile, buildEventCatalog } from './lib/error-catalog-files.ts';

const root = resolve(import.meta.dirname, '..');
writeFileSync(resolve(root, 'docs/api/errors.json'), buildErrorCatalogFile());
writeFileSync(resolve(root, 'docs/api/webhook-events.json'), buildEventCatalog());
