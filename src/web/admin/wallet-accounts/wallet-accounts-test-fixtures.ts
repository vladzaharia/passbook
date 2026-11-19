import type {
  PlatformWalletEnrolment,
  WalletCredential,
  WalletEnrolment,
} from '@/shared/contracts/wallet-providers.ts';

export const KEY = '-----BEGIN PRIVATE KEY-----\nU0VDUkVUX0tFWQ==\n-----END PRIVATE KEY-----';

export const enrolment = (over: Partial<WalletEnrolment> = {}): WalletEnrolment => ({
  mode: 'test',
  provider: 'google',
  accountId: null,
  source: null,
  platformAvailable: true,
  state: 'absent',
  enrolmentRevision: 0,
  prerequisites: { check: false, roundTrip: null },
  hold: null,
  issuance: { state: 'disabled', reason: 'not_released' },
  ...over,
});

export const credential = (over: Partial<WalletCredential> = {}): WalletCredential => ({
  id: 'c1',
  scope: 'org',
  orgId: 'o1',
  mode: 'test',
  provider: 'google',
  identityHint: '4321',
  revision: 1,
  verifiedAt: null,
  revokedAt: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...over,
});

export const platformEnrolment = (
  over: Partial<PlatformWalletEnrolment> = {},
): PlatformWalletEnrolment => ({
  orgId: 'o1',
  orgName: 'North',
  mode: 'live',
  provider: 'google',
  source: 'platform',
  state: 'on',
  hold: null,
  updatedAt: 1_700_000_000_000,
  ...over,
});
