import { test as setup } from '@playwright/test';
import { apiAs } from './helpers/api.ts';
import { type Role, saveState, signInAs } from './helpers/auth.ts';
import { createSeed } from './helpers/seed.ts';

for (const [role, landing] of [
  ['admin', '/admin'],
  ['user', '/'],
  ['reviewer', '/'],
] as [Role, string][]) {
  setup(`sign in as ${role}`, async ({ page }) => {
    await signInAs(page, role, landing);
    await saveState(page, role);
  });
}

setup('seed org', async () => {
  const api = await apiAs('admin');
  try {
    await createSeed(api);
  } finally {
    await api.dispose();
  }
});
