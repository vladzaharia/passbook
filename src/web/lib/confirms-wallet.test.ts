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
    expect(walletMigrationConfirm('merge', 'North', ['North', 'Acme']).description).toBe(
      "This identity becomes PassBook's credential. North, Acme and any other organization that claims it will sign with it.",
    );
    expect(walletMigrationConfirm('merge', 'North').description).toBe(
      "This identity becomes PassBook's credential. Any other organization that claims it will sign with it.",
    );
  });
});
