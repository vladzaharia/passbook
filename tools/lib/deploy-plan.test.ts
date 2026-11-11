import { describe, expect, it } from 'vitest';
import { deployFlags, missingSecrets } from './deploy-plan.ts';

describe('deployFlags', () => {
  it('reads argv', () => {
    expect(deployFlags(['--apply', '--secrets'], {})).toEqual(new Set(['--apply', '--secrets']));
  });

  it('reads allow flags from npm config, never --apply', () => {
    const flags = deployFlags([], {
      npm_config_allow_no_push: 'true',
      npm_config_apply: 'true',
      npm_config_secrets: 'false',
    });
    expect(flags).toEqual(new Set(['--allow-no-push']));
  });
});

describe('missingSecrets', () => {
  it('returns names only', () => {
    const list = JSON.stringify([{ name: 'A', type: 'secret_text' }]);
    expect(missingSecrets(['A', 'B'], list)).toEqual(['B']);
  });
});
