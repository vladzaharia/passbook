import { expect, it } from 'vitest';
import { impactLines } from './impact.ts';

const i = (channel: string, passes: number, clearedOverrides = 0) =>
  ({ channel, passes, rotated: 0, clearedOverrides }) as never;

it('says what turns off and that copies keep working', () => {
  expect(impactLines([i('apple', 412)])).toEqual([
    'Turns off Apple Wallet for 412 passes.',
    'Copies keep working until New code.',
  ]);
});

it('counts overrides a Never clears, and singular passes', () => {
  expect(impactLines([i('paper', 1, 37)])).toEqual([
    'Turns off Paper for 1 pass.',
    'Clears 37 pass overrides.',
  ]);
});

it('says so when nothing changes', () => {
  expect(impactLines([i('apple', 0)])).toEqual(['No passes change.']);
});
