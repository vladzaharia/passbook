import { describe, expect, it } from 'vitest';
import { classify, isSecret, missTerm, routeMatches } from './developers-search.ts';

const SECRETS = [
  'pb_test_9fK2xQ7mLp3sD8vA9fK2',
  'pb_live_ab12cd_9fK2xQ7mLp3sD8vA',
  'pbp_test_9fK2xQ7mLp3sD8vA',
  'pbo_9fK2xQ7mLp3sD8vA',
  'pbtry_eyJ2MTprZXk6c2Vz.9fK2xQ7mLp3sD8vA',
  'wlt_9fK2xQ7mLp3sD8vA',
  'whsec_9fK2xQ7mLp3sD8vA9fK2xQ7mLp3sD8vA9fK2xQ7mLp',
  'curl -H "Authorization: Bearer pb_live_ab12_9fK2xQ7mLp3sD8vA" https://x',
];

describe('classify', () => {
  it('knows a secret in every prefix, alone or inside pasted text, and keeps its last four for the label', () => {
    for (const text of SECRETS) {
      expect(isSecret(text), text).toBe(true);
      expect(classify(text).kind, text).toBe('secret');
    }
    expect(classify('pb_test_9fK2xQ7mLp3sD8vA9fK2')).toEqual({
      kind: 'secret',
      tail: '9fK2',
      signing: false,
    });
    expect(classify('whsec_9fK2xQ7mLp3sD8vA9fK2xQ7mLp3sD8vA9fK2xQ7mLp')).toMatchObject({
      kind: 'secret',
      signing: true,
    });
  });

  it('does not call a word a secret: a prefix being typed, a name that merely contains one', () => {
    for (const text of ['pb_', 'pb_test', 'pbtry', 'wlt', 'webhook_secret', 'alpb_test_xxxxxxxx'])
      expect(classify(text).kind, text).not.toBe('secret');
  });

  it('knows a request id and an object id, lower-cased', () => {
    expect(classify(' 0193A1B2-7C00-7000-8000-0000000000C1 ')).toEqual({
      kind: 'id',
      id: '0193a1b2-7c00-7000-8000-0000000000c1',
    });
    expect(classify('8A1B2C3D4E5F6A7B-LHR')).toEqual({ kind: 'id', id: '8a1b2c3d4e5f6a7b-lhr' });
  });

  it('knows a route, with or without a method or /api/v1', () => {
    expect(classify('POST /passes')).toEqual({ kind: 'route', method: 'POST', path: '/passes' });
    expect(classify('get /api/v1/passes/0193a1b2/void?x=1')).toEqual({
      kind: 'route',
      method: 'GET',
      path: '/passes/0193a1b2/void',
    });
    expect(classify('/templates/')).toEqual({ kind: 'route', method: null, path: '/templates' });
    expect(classify('release checklist').kind).toBe('text');
    expect(classify('').kind).toBe('text');
  });

  it('matches a route pattern against real values', () => {
    expect(routeMatches('/passes/{id}/void', '/passes/0193a1b2/void')).toBe(true);
    expect(routeMatches('/passes/{id}', '/passes/0193a1b2/void')).toBe(false);
    expect(routeMatches('/passes', '/passes')).toBe(true);
    expect(routeMatches('/passes', '/templates')).toBe(false);
  });
});

describe('missTerm', () => {
  it('keeps short plain words, lower-cased and squeezed', () => {
    expect(missTerm('  Refund   Policy ')).toBe('refund policy');
    expect(missTerm('passes.create')).toBe('passes.create');
    expect(missTerm('post /widgets')).toBe('post /widgets');
    expect(missTerm('POST /templates/{id}/releases')).not.toBeNull();
    expect(missTerm('oauth2 scopes')).toBe('oauth2 scopes');
    expect(missTerm('x509 certificate')).toBe('x509 certificate');
  });

  it('keeps nothing that could be personal or a credential', () => {
    const refused = [
      ...SECRETS,
      'pb_',
      'pb_te',
      'pbtry_a',
      '0193a1b2-7c00-7000-8000-0000000000c1',
      '8a1b2c3d4e5f6a7b-LHR',
      'maya@example.com',
      'https://example.com/pass',
      'order 4400123987',
      'a3f9c0de12b4a3f9c0de',
      'AbCdEfGhIjKl0123456789',
      '"quoted"',
      'x',
      'y'.repeat(61),
      '555-123-4567',
      '415 555 0199',
      '(415) 555-0199',
      '+44 20 7946 0958',
      '4242 4242 4242 4242',
      '4242-4242-4242-4242',
      '424242424242',
      'maya smith 12 main st',
      '4 Oak Avenue',
      '1600 pennsylvania ave',
      'join/Ab3dE5gH7jK9',
      '/join/Ab3dE5gH7jK9mN',
      'invite/x7Yz1Qw',
      'passbook.mobile/join/tok3nValue',
      '/p/Ab3dE5gH7jK9mN2pQ',
      '/passes/abcdefghijklmnopqrstuv',
    ];
    for (const text of refused) expect(missTerm(text), text).toBeNull();
  });
});
