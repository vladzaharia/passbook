import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * One brand for every holder surface: each route and mailer that draws an org's page, shell or
 * email gets it from `orgBrandOf`, never from its own read of the branding column.
 */
const SURFACES = [
  'src/worker/modules/public/routes.ts',
  'src/worker/modules/public/presentation.ts',
  'src/worker/modules/bundles/public-routes.ts',
  'src/worker/modules/join/routes-public.ts',
  'src/worker/modules/prints/routes-holder.ts',
  'src/worker/modules/prints/routes.ts',
  'src/worker/modules/delivery/email.ts',
  'src/worker/modules/bundles/deliver.ts',
  'src/worker/modules/orgs/email-preview.ts',
];

describe('every holder surface uses orgBrandOf', () => {
  for (const file of SURFACES) {
    it(file, () => {
      const source = readFileSync(file, 'utf8');
      expect(source).toMatch(/orgBrandOf\(/);
      // No surface decodes the web logo or mark from the branding column itself.
      expect(source).not.toMatch(/branding\.(web|mark)\b/);
    });
  }
});
