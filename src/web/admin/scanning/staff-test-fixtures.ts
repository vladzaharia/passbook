import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { json, membershipFixture } from '@/web/lib/test-utils.tsx';
import type { ScanStaff } from './staff-dialogs.tsx';

export function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

export const person = (overrides: Partial<ScanStaff> = {}): ScanStaff => ({
  id: 'staff-1',
  orgId: 'o1',
  name: 'Sam K.',
  role: 'door',
  pinSetAt: 1_800_000_000_000,
  locked: false,
  disabledAt: null,
  today: 0,
  lastScan: null,
  ...overrides,
});
const empty = () => json({ items: [], nextCursor: null });
export const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
export const otherHandlers = { '/api/v1/scan-setups': empty, '/api/v1/scan-events': empty };

export async function openAction(name: string, action: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
}
