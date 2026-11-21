import { describe, expect, it } from 'vitest';
import { chainOf, channelOf } from '../pass-setup-test-fixtures.ts';
import { channelStatusLine, fixLabel, PASS_SETUP_COPY } from './pass-setup.ts';

describe('channelStatusLine', () => {
  it.each([
    ['not released', channelOf({ level: 'passbook', reason: 'not_released' }), 'Not available yet'],
    ['not in the plan', channelOf({ level: 'plan', reason: 'not_included' }), 'Not in your plan'],
    ['blocked', channelOf({ level: 'org', reason: 'blocked' }), 'Blocked'],
    ['tags off', channelOf({ level: 'org', reason: 'tags_off' }), 'Blocked'],
    ['no account', channelOf({ level: 'org', reason: 'not_enrolled' }), 'Account needed'],
    ['on everywhere', channelOf(), 'On'],
    [
      'on for some',
      channelOf(undefined, {
        levels: chainOf(undefined, 'partial'),
        templates: { on: 2, off: 1, never: 0, total: 3 },
      }),
      'On for 2 of 3 templates',
    ],
    [
      'off for all',
      channelOf(undefined, {
        levels: chainOf(undefined, 'off'),
        templates: { on: 0, off: 2, never: 1, total: 3 },
      }),
      'Off for every template',
    ],
    [
      'no templates',
      channelOf(undefined, { templates: { on: 0, off: 0, never: 0, total: 0 } }),
      'On',
    ],
  ])('%s', (_name, row, want) => {
    expect(channelStatusLine(row)).toBe(want);
  });
});

describe('fixLabel', () => {
  it('names the channel to allow, and leaves others as they are', () => {
    expect(fixLabel('allow_channel', 'apple')).toBe('Allow Apple Wallet');
    expect(fixLabel('upload_logo')).toBe('Add logo');
  });
});

it('the org reads Shared for PassBook identity', () => {
  expect(PASS_SETUP_COPY.identityKinds.platform).toBe('Shared');
  expect(PASS_SETUP_COPY.levels.plan).toBe('Plan');
});
