// Writes docs/api/webhook-vectors.json from the server's real signing. Run via `npm run gen`; check-developers fails when it drifts.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildWebhookVectors } from './lib/webhook-vectors.ts';

writeFileSync(
  resolve(import.meta.dirname, '../docs/api/webhook-vectors.json'),
  await buildWebhookVectors(),
);
