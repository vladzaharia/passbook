import { describe, expect, it } from 'vitest';
import { OrgSettingsSchema } from './settings.ts';

describe('OrgSettingsSchema email.buddy', () => {
  it('is off unless the org opts in', () => {
    expect(OrgSettingsSchema.parse({})['email.buddy']).toBe(false);
    expect(OrgSettingsSchema.shape['email.buddy'].safeParse(undefined)).toEqual({
      success: true,
      data: false,
    });
    expect(OrgSettingsSchema.parse({ 'email.buddy': true })['email.buddy']).toBe(true);
  });

  it('takes a boolean only', () => {
    for (const value of ['true', 1, null, 'on']) {
      expect(OrgSettingsSchema.shape['email.buddy'].safeParse(value).success).toBe(false);
    }
  });
});
