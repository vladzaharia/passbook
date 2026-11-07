import { expect, it } from 'vitest';
import type { ScannerSettings } from '../../../shared/contracts/scan.ts';
import { fixtureCounts, states } from './fixtures.test-support.ts';
import { fakeClock, fakeDeps, flush } from './store.test-support.ts';
import { createScanStore } from './store.ts';

const settings: ScannerSettings = {
  flow: 'auto',
  reader: 'barcode',
  roleWithoutSignIn: 'door',
  staffSignIn: false,
  letInAgain: 'anyone',
  lookup: true,
  offline: false,
  dailyAmount: null,
  defaultActionId: null,
};
it('applies configuration without stopping the session or losing its recent scans', async () => {
  const fake = fakeDeps(fakeClock());
  const initial = states.ready();
  const store = createScanStore(fake.deps, initial);
  expect(store.configure({ ...settings, flow: 'choose' }, fixtureCounts({ configRev: 2 }))).toBe(
    true,
  );
  expect(store.getSnapshot().state).toMatchObject({
    started: true,
    posture: 'desk',
    camera: 'disabled',
    reader: { kind: 'barcode' },
    recent: initial.recent,
  });
  store.dispatch({
    type: 'read',
    input: { id: 'next', at: 1, method: 'manual', code: 'NEW', sig: 'c:NEW' },
  });
  await flush();
  expect(fake.api.resolve).toHaveBeenCalledOnce();
  expect(fake.api.act).not.toHaveBeenCalled();
  store.dispose();
});
it('defers configuration while a scan or lookup is in progress', () => {
  const fake = fakeDeps(fakeClock());
  for (const state of [
    states.checking(),
    states.reviewing(),
    { ...states.ready(), overlay: 'lookup' as const },
  ]) {
    const store = createScanStore(fake.deps, state);
    expect(store.configure(settings, fixtureCounts({ configRev: 2 }))).toBe(false);
    expect(store.getSnapshot().state).toBe(state);
    store.dispose();
  }
});
