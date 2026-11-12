import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { recordedCheckIn } from './console-privacy-actions-test-fixtures.ts';
import {
  fake,
  kit,
  MANAGER,
  page,
  privatePass,
  type Row,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';

setupPrivacyKit();

const CONTACT = 'feed-contact-sentinel@example.test';

const byId = (items: Row[]) => new Map(items.map((item) => [item.id, item]));

describe('API-key feed effect values', () => {
  it("drops values the door may not see, as the console's policy does, and keeps safe ones", async () => {
    // A manager records the scans, so the console's manager may see manager-only values.
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [templateId],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    const pass = await privatePass();
    const hidden = await recordedCheckIn(scanner, pass.id);
    const plain = await recordedCheckIn(scanner, pass.id);
    // Stored effect facts: a manager-only input's value and a contact-like string; numbers as the control.
    await run(kit.env.DB, 'UPDATE scans SET before_value=?, after_value=? WHERE id=?', [
      JSON.stringify(MANAGER),
      JSON.stringify(CONTACT),
      hidden.id,
    ]);
    await run(kit.env.DB, 'UPDATE scans SET before_value=?, after_value=? WHERE id=?', [
      '3',
      '4',
      plain.id,
    ]);

    const console = byId((await page(`?orgId=${kit.org.id}`)).items);
    // The console's manager sees the manager-only value; nobody sees contact data.
    expect(console.get(hidden.id)).toMatchObject({ before: MANAGER, after: null });
    expect(console.get(plain.id)).toMatchObject({ before: 3, after: 4 });

    const feed = await page('', fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] }));
    const items = byId(feed.items);
    expect(items.get(hidden.id)).toMatchObject({ before: null, after: null });
    expect(items.get(plain.id)).toMatchObject({ before: 3, after: 4 });
    expect(JSON.stringify(feed)).not.toContain(MANAGER);
    expect(JSON.stringify(feed)).not.toContain(CONTACT);
  });
});
