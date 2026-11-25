import { describe, expect, it } from 'vitest';
import {
  auditScopeAllowed,
  CREDENTIAL_SCOPES,
  MINTABLE_SCOPES,
  TEMPLATE_ACT_AS_SCOPES,
  TEST_ONLY_SCOPES,
} from './contracts/api-keys.ts';
import { SANDBOX_KEY_SCOPES } from './contracts/developer-home.ts';
import {
  adminPresets,
  fullAccess,
  holdableScopes,
  KEY_PRESETS,
  presetsWithin,
  selectedPreset,
} from './developers-keys.ts';

const ALL = [...KEY_PRESETS, fullAccess('test')];
const KINDS = ['service', 'personal', 'platform'] as const;
const MODES = ['live', 'test'] as const;
const ids = (ceiling: readonly string[], mode: 'live' | 'test') =>
  adminPresets(ceiling, mode).map((p) => p.id);

describe('key presets', () => {
  it('hold only mintable scopes, never a credential scope or key minting', () => {
    for (const p of ALL)
      for (const s of p.scopes) {
        expect(MINTABLE_SCOPES).toContain(s);
        expect(CREDENTIAL_SCOPES as readonly string[]).not.toContain(s);
        expect(s).not.toBe('api-keys:write');
      }
  });

  it('are subsets of what each kind and mode may hold, or hidden', () => {
    for (const kind of KINDS)
      for (const mode of MODES) {
        const ceiling = holdableScopes(kind, null, mode);
        for (const p of adminPresets(ceiling, mode))
          for (const s of p.scopes) expect(ceiling).toContain(s);
      }
  });

  it('keep the terminal scope to service keys', () => {
    for (const kind of ['personal', 'platform'] as const)
      expect(ids(holdableScopes(kind, null), 'live')).not.toContain('till');
    expect(ids(holdableScopes('service', null), 'live')).toContain('till');
  });

  it('hide review and release in Live, and the audit log in Test', () => {
    const live = holdableScopes('service', null, 'live');
    const test = holdableScopes('service', null, 'test');
    for (const s of TEST_ONLY_SCOPES) {
      expect(live).not.toContain(s);
      expect(test).toContain(s);
    }
    expect(ids(live, 'live')).not.toContain('release');
    expect(ids(test, 'test')).toContain('release');
    expect(ids(live, 'live')).toContain('audit');
    expect(ids(test, 'test')).not.toContain('audit');
    expect(adminPresets(live, 'live').at(-1)?.scopes).not.toContain('audit:read');
  });

  it('keeps a platform key off an organization setup, template and audit scopes', () => {
    const held = holdableScopes('platform', null, 'live');
    for (const s of ['org:write', 'wallet:write', 'audit:read', ...TEMPLATE_ACT_AS_SCOPES])
      expect(held).not.toContain(s);
  });

  it('offers Full access when everything it holds fits, never with audit or credential scopes', () => {
    for (const mode of MODES) {
      const full = fullAccess(mode);
      expect(full.scopes.every((s) => SANDBOX_KEY_SCOPES.includes(s))).toBe(true);
      expect(full.scopes).not.toContain('audit:read');
      expect(ids(holdableScopes('service', null, mode), mode).at(-1)).toBe('full');
    }
    expect(ids(holdableScopes('personal', ['passes:read']), 'live')).not.toContain('full');
  });

  it('marks the preset a checklist equals, in any order', () => {
    const presets = adminPresets(holdableScopes('service', null), 'live');
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

  it('lets a developer sandbox hold the audit log in Test, by the rule the server uses', () => {
    expect(auditScopeAllowed('live', false)).toBe(true);
    expect(auditScopeAllowed('test', false)).toBe(false);
    expect(auditScopeAllowed('test', true)).toBe(true);
    expect(holdableScopes('service', null, 'test', true)).toContain('audit:read');
    expect(holdableScopes('service', null, 'test', false)).not.toContain('audit:read');
    expect(ids(holdableScopes('service', null, 'test', true), 'test')).toContain('audit');
  });
});
