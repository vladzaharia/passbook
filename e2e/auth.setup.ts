import { test as setup } from '@playwright/test';
import { e2eReleaseMismatch } from '../tools/lib/e2e-release.ts';
import { apiAs } from './helpers/api.ts';
import { type Role, saveState, signInAs } from './helpers/auth.ts';
import { templateFromBlueprint } from './helpers/releases.ts';
import { createSeed } from './helpers/seed.ts';
import { releasedOn } from './helpers/wallets.ts';

for (const [role, landing] of [
  ['admin', '/admin'],
  ['user', '/'],
  ['reviewer', '/'],
  ['developer', '/'],
] as [Role, string][]) {
  setup(`sign in as ${role}`, async ({ page }) => {
    await signInAs(page, role, landing);
    await saveState(page, role);
  });
}

setup('seed org', async () => {
  const api = await apiAs('admin');
  try {
    // A reused server must match the run: providers open only for playwright.wallets.config.ts.
    const wantOpen = setup.info().config.metadata.walletsRelease === true;
    const mismatch = e2eReleaseMismatch(await releasedOn(api), wantOpen);
    if (mismatch) throw new Error(mismatch);
    await createSeed(api, (orgId) =>
      templateFromBlueprint(api, orgId, 'E2E Generic', ['live', 'test']),
    );
  } finally {
    await api.dispose();
  }
});
