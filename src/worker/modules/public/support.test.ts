import { beforeAll, describe, expect, it } from 'vitest';
import { saveOrgSettings } from '../../../../test/helpers/index.ts';
import { platformSupportEmail } from '../../platform/support.ts';
import { backContactsFor, withBackContacts } from '../passes/contacts.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { supportContacts } from './service.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

describe('PassBook support', () => {
  it('reads SUPPORT_EMAIL and drops an invalid or empty one', () => {
    expect(platformSupportEmail(kit.env)).toBe('support@passbook.mobile');
    expect(platformSupportEmail({ SUPPORT_EMAIL: ' Help@PassBook.mobile ' })).toBe(
      'help@passbook.mobile',
    );
    for (const bad of ['', 'nope', 'a@b', undefined]) {
      expect(platformSupportEmail({ SUPPORT_EMAIL: bad })).toBeNull();
    }
  });

  it('never fills the pass-service slot with the platform address or site', async () => {
    const contacts = await backContactsFor(kit.ctx, kit.org.id, {});
    const pass = withBackContacts(
      {
        generic: { backFields: [{ key: 'pass-service', label: 'Pass service', value: '' }] },
      } as never,
      contacts,
    );
    expect(JSON.stringify(pass)).not.toContain('passbook.mobile');
    expect(JSON.stringify(pass)).not.toContain('pass-service');
  });

  it('falls back to PassBook support only when the org has none', async () => {
    expect(await supportContacts(kit.ctx, kit.org.id)).toEqual({
      email: 'support@passbook.mobile',
      url: null,
      platform: true,
    });
    await saveOrgSettings(
      kit.ctx.env.DB,
      kit.org.id,
      { 'support.email': 'help@acme.test' },
      kit.ctx.clock.now(),
    );
    expect(await supportContacts(kit.ctx, kit.org.id)).toEqual({
      email: 'help@acme.test',
      url: null,
    });
  });
});
