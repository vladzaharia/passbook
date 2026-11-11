import { describe, expect, it } from 'vitest';
import { deployFlags, deployStage, missingSecrets } from './deploy-plan.ts';

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

describe('deployStage', () => {
  it('runs everything unless a stage is named', () => {
    expect(deployStage(new Set(['--apply']))).toBe('all');
    expect(deployStage(new Set(['--migrate-only']))).toBe('migrate');
    expect(deployStage(new Set(['--promote', '--first']))).toBe('promote');
  });

  it('refuses both stages in one run', () => {
    expect(() => deployStage(new Set(['--migrate-only', '--promote']))).toThrow('separate runs');
  });
});
