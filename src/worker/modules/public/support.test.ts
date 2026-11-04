import { beforeAll, describe, expect, it } from 'vitest';
import { platformSupportEmail } from '../../platform/support.ts';
import { backContactsFor, passServiceText, withBackContacts } from '../passes/contacts.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';
import { updateSettings } from '../settings/service.ts';
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

  it('names PassBook and its site in the pass-service slot', async () => {
    expect(passServiceText(kit.env)).toBe(
      'PassBook · support@passbook.mobile\nhttps://passbook.mobile',
    );
    expect(passServiceText({ ...kit.env, SUPPORT_EMAIL: '' } as typeof kit.env)).toBe(
      'https://passbook.mobile',
    );
    const contacts = await backContactsFor(kit.ctx, kit.org.id, {});
    const pass = withBackContacts(
      {
        generic: { backFields: [{ key: 'pass-service', label: 'Pass service', value: '' }] },
      } as never,
      contacts,
    );
    expect(JSON.stringify(pass)).toContain('support@passbook.mobile');
  });

  it('falls back to PassBook support only when the org has none', async () => {
    expect(await supportContacts(kit.ctx, kit.org.id)).toEqual({
      email: 'support@passbook.mobile',
      url: null,
      platform: true,
    });
    await updateSettings(
      kit.ctx,
      { type: 'user', id: 'admin-1' },
      { scope: `org:${kit.org.id}`, values: { 'support.email': 'help@acme.test' } },
    );
    expect(await supportContacts(kit.ctx, kit.org.id)).toEqual({
      email: 'help@acme.test',
      url: null,
    });
  });
});
