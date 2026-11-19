import { describe, expect, it } from 'vitest';
import { revokeWalletCredentialConfirm, walletMigrationConfirm } from './confirms-wallet.ts';

describe('wallet confirm copy', () => {
  it('revokes wallet credentials and says organizations turn Off', () => {
    expect(revokeWalletCredentialConfirm('Google Wallet')).toEqual({
      title: 'Revoke Google Wallet credentials?',
      confirmLabel: 'Revoke',
      description: 'Organizations using them turn Off. This cannot be undone.',
      typed: false,
    });
  });

  it('words each migration step', () => {
    expect(walletMigrationConfirm('retire', 'North, Google Wallet')).toEqual({
      title: 'Retire North, Google Wallet?',
      confirmLabel: 'Retire',
      description: 'Revokes the legacy account. This cannot be undone.',
      typed: false,
    });
    expect(walletMigrationConfirm('migrate', '').confirmLabel).toBe('Run');
  });
});
