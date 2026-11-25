import { describe, expect, it } from 'vitest';
import type { WalletInstance } from './instance.ts';
import { instanceCanActivate } from './offers-instance.ts';

const instance = (over: Partial<WalletInstance>) =>
  ({
    lifecycle: 'active',
    credentialGeneration: 2,
    retirementCause: null,
    channelEpoch: 1,
    ...over,
  }) as WalletInstance;

// Listing and issuing share this check, for both providers: an offer listed is an offer issue can create.
describe('an offer can only be listed when issue can activate its slot', () => {
  it.each([
    ['no instance yet', null, true],
    ['an active instance at the pass generation', instance({}), true],
    ['an active instance at an older generation', instance({ credentialGeneration: 1 }), false],
    ['a ready placeholder after a transfer', instance({ lifecycle: 'ready' }), false],
    ['a blocked placeholder', instance({ lifecycle: 'blocked' }), false],
    [
      'a settled channel-off predecessor (a successor is born active)',
      instance({ lifecycle: 'retired', retirementCause: 'channel_off', credentialGeneration: 1 }),
      true,
    ],
  ])('%s', (_name, existing, expected) => {
    expect(instanceCanActivate(existing, 2)).toBe(expected);
  });
});
