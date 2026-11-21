import { beforeAll, describe, expect, it } from 'vitest';
import { door, fixture, post } from './setup-intent-test-fixtures.ts';

let templateId: string;
beforeAll(async () => {
  await fixture.setup();
  templateId = await fixture.kit.scanTemplate('Sign-in pass', {
    actions: [{ id: 'entry', label: 'Check in', kind: 'check_in' }],
  });
});

describe('scanning setup sign-in', () => {
  it('refuses an email-link session with IDP_SIGN_IN_REQUIRED', async () => {
    const emailLink = fixture.fake.session({ amr: 'magic_link', roles: ['admin'] });
    const res = await post(
      { orgId: fixture.kit.org.id, preset: 'front_desk', doors: [door(templateId)] },
      emailLink,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'IDP_SIGN_IN_REQUIRED' });
  });
});
