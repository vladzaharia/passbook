import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, renderApp } from '@/web/lib/test-utils.tsx';
import { memoryStorage, northwind, otherHandlers } from './staff-test-fixtures.ts';

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => {
  resetModeForTests();
  vi.unstubAllGlobals();
});

async function open(off: boolean, puts: unknown[]) {
  let current = off;
  await renderApp('/admin/scanning?tab=staff&orgId=o1', {
    session: 'admin',
    memberships: [northwind],
    selectedOrg: 'o1',
    handlers: {
      ...otherHandlers,
      '/api/v1/scan-staff': () => json({ items: [], ...(current ? { pinOnlyOff: true } : {}) }),
      '/api/v1/settings': async (_url, init) => {
        if (init?.method === 'PUT') {
          puts.push(JSON.parse(String(init.body)));
          current = false;
        }
        return json({ items: [], configRevision: 1 });
      },
    },
  });
}

describe('PIN-only sign-in notice', () => {
  it('says PIN-only is off and turns it on', async () => {
    const puts: unknown[] = [];
    await open(true, puts);
    expect(
      await screen.findByText('PIN-only sign-in off after repeated wrong PINs.'),
    ).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(screen.queryByText(/PIN-only sign-in off/)).not.toBeInTheDocument());
    expect(puts).toEqual([{ scope: 'org:o1', values: { 'scan.pinOnly': true } }]);
  });

  it('shows nothing while it is on', async () => {
    await open(false, []);
    await screen.findByText('No staff yet');
    expect(screen.queryByText(/PIN-only sign-in off/)).not.toBeInTheDocument();
  });
});
