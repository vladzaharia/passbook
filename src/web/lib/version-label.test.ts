import { describe, expect, it } from 'vitest';
import { versionLabel } from './status.ts';

describe('versionLabel', () => {
  it('names the source first, else the cause', () => {
    expect(versionLabel({ cause: 'admin', source: 'broadcast' })).toBe('Message');
    expect(versionLabel({ cause: 'admin', source: 'schedule' })).toBe('Scheduled change');
    expect(versionLabel({ cause: 'admin', source: 'remove' })).toBe('Removed from Wallet');
    expect(versionLabel({ cause: 'admin', source: 'restore' })).toBe('Restored');
    expect(versionLabel({ cause: 'admin', source: null })).toBe('Admin edit');
    expect(versionLabel({ cause: 'connection' })).toBe('Connection sync');
  });
});
