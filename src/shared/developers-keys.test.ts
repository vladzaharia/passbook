import { describe, expect, it } from 'vitest';
import { CREDENTIAL_SCOPES, MINTABLE_SCOPES } from './contracts/api-keys.ts';
import { SANDBOX_KEY_SCOPES } from './contracts/developer-home.ts';
import {
  adminPresets,
  FULL_ACCESS,
  holdableScopes,
  KEY_PRESETS,
  presetsWithin,
  selectedPreset,
} from './developers-keys.ts';

const ALL = [...KEY_PRESETS, FULL_ACCESS];
const KINDS = ['service', 'personal', 'platform'] as const;

describe('key presets', () => {
  it('hold only mintable scopes, never a credential scope or key minting', () => {
    for (const p of ALL)
      for (const s of p.scopes) {
        expect(MINTABLE_SCOPES).toContain(s);
        expect(CREDENTIAL_SCOPES as readonly string[]).not.toContain(s);
        expect(s).not.toBe('api-keys:write');
      }
  });

  it('are subsets of what each kind may hold, or hidden', () => {
    for (const kind of KINDS) {
      const ceiling = holdableScopes(kind, null);
      for (const p of adminPresets(ceiling)) for (const s of p.scopes) expect(ceiling).toContain(s);
    }
  });

  it('keep the terminal scope to service keys', () => {
    for (const kind of ['personal', 'platform'] as const) {
      const ids = adminPresets(holdableScopes(kind, null)).map((p) => p.id);
      expect(ids).not.toContain('till');
    }
    expect(adminPresets(holdableScopes('service', null)).map((p) => p.id)).toContain('till');
  });

  it('offers Full access exactly when the whole sandbox ceiling fits', () => {
    expect(FULL_ACCESS.scopes).toEqual(SANDBOX_KEY_SCOPES);
    expect(adminPresets(holdableScopes('service', null)).at(-1)?.id).toBe('full');
    expect(
      adminPresets(holdableScopes('personal', ['passes:read'])).map((p) => p.id),
    ).not.toContain('full');
  });

  it('marks the preset a checklist equals, in any order', () => {
    const presets = adminPresets(holdableScopes('service', null));
    expect(selectedPreset(presets, ['templates:read', 'passes:write', 'passes:read'])?.id).toBe(
      'issue',
    );
    expect(selectedPreset(presets, ['passes:read'])).toBeNull();
  });

  it('have unique ids and labels, and the sandbox list drops those it cannot hold', () => {
    expect(new Set(ALL.map((p) => p.id)).size).toBe(ALL.length);
    expect(new Set(ALL.map((p) => p.label)).size).toBe(ALL.length);
    expect(presetsWithin(SANDBOX_KEY_SCOPES).map((p) => p.id)).not.toContain('till');
  });
});
