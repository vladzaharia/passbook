import { describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/index.ts';
import { hashPin, pinMatches } from './staff-pin.ts';
import { DUMMY_PIN_HASH } from './staff-pin-decide.ts';

const kek = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));

describe('staff PINs across a MAC root rotation', () => {
  it('accepts a PIN hashed under the previous root only while it is set', async () => {
    const before = { ...(await makeEnv({ KEK_V1: kek(1) })), KEK_V2: kek(2) };
    const stored = await hashPin(before, 'staff-1', '4321');
    const during = { ...before, MAC_KEY_VERSION: '2', MAC_KEY_VERSION_PREVIOUS: '1' };
    const after = { ...before, MAC_KEY_VERSION: '2' };
    expect(await pinMatches(before, 'staff-1', '4321', stored)).toBe(true);
    // Mid-rotation the old hash still verifies, so a correct PIN is no miss and locks no scanner.
    expect(await pinMatches(during, 'staff-1', '4321', stored)).toBe(true);
    expect(await pinMatches(during, 'staff-1', '4320', stored)).toBe(false);
    expect(await pinMatches(during, 'staff-2', '4321', stored)).toBe(false);
    // A PIN set under the new root verifies under both settings.
    const fresh = await hashPin(after, 'staff-1', '4321');
    expect(fresh).not.toBe(stored);
    expect(await pinMatches(during, 'staff-1', '4321', fresh)).toBe(true);
    expect(await pinMatches(after, 'staff-1', '4321', fresh)).toBe(true);
    // Without the previous root the old hash is a wrong PIN: the owner resets it.
    expect(await pinMatches(after, 'staff-1', '4321', stored)).toBe(false);
    expect(await pinMatches(during, 'staff-1', '4321', DUMMY_PIN_HASH)).toBe(false);
  });
});
