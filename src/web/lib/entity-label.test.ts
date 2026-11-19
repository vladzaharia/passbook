import { describe, expect, it } from 'vitest';
import { entityLabel, looksLikeId } from './entity-label.ts';

describe('entityLabel', () => {
  it('keeps a real name', () => {
    expect(entityLabel('Ada Lovelace', 'User')).toBe('Ada Lovelace');
    expect(entityLabel('  Gym pass ', 'Pass')).toBe('Gym pass');
  });
  it('falls back to the kind for empty names', () => {
    expect(entityLabel(null, 'User')).toBe('User');
    expect(entityLabel(undefined, 'Pass')).toBe('Pass');
    expect(entityLabel('   ', 'Pass')).toBe('Pass');
  });
  it('never shows a uuid, hash or token', () => {
    expect(entityLabel('01a1f0e7-11ed-788a-979d-ee1c11ee04d4', 'Pass')).toBe('Pass');
    expect(entityLabel('b95c69194c2acbf1', 'Template')).toBe('Template');
    expect(entityLabel('wlt_9fk2x81qzm', 'API key')).toBe('API key');
  });
  it('keeps snake_case names and plain words', () => {
    expect(entityLabel('welcome_campaign', 'Message')).toBe('welcome_campaign');
    expect(entityLabel('onboarding_flow', 'Message')).toBe('onboarding_flow');
    expect(entityLabel('deadbeefcafe', 'Pass')).toBe('deadbeefcafe');
  });
  it('does not mistake short words for ids', () => {
    expect(looksLikeId('deadbeef')).toBe(false);
    expect(looksLikeId('Facade')).toBe(false);
  });
});
