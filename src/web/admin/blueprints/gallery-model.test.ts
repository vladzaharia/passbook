import { describe, expect, it } from 'vitest';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { entriesOf } from './gallery-model.ts';

const bp = (slug: string, name: string, group: string) =>
  ({ id: `baked:starter-${slug}`, name, group }) as unknown as TemplateSummaryDto;

describe('entriesOf', () => {
  it('orders every group most common first, not by name', () => {
    const items = [
      bp('permit', 'A permit', 'prove-collect'),
      bp('pickup', 'Z pickup', 'prove-collect'),
      bp('pack', 'A pack', 'save-spend'),
      bp('coupon', 'Z coupon', 'save-spend'),
      bp('id-card', 'A id', 'membership-id'),
      bp('generic', 'Z membership', 'membership-id'),
      bp('booking', 'A booking', 'get-in'),
      bp('transit-ticket', 'B transit', 'get-in'),
      bp('timed-ticket', 'C timed', 'get-in'),
      bp('event-ticket', 'Z event', 'get-in'),
    ];
    const slugs = (g: string) =>
      entriesOf(items)
        .filter((e) => e.group === g)
        .map((e) => e.id.replace(/^.*starter-/, ''));
    expect(slugs('get-in')).toEqual(['event-ticket', 'timed-ticket', 'transit-ticket', 'booking']);
    expect(slugs('save-spend')).toEqual(['coupon', 'pack']);
    expect(slugs('membership-id')).toEqual(['generic', 'id-card']);
    expect(slugs('prove-collect')).toEqual(['pickup', 'permit']);
  });

  it('puts the entry passes right after the access card', () => {
    const items = ['guest-pass', 'day-pass', 'monthly-pass', 'timed-ticket', 'access-card'].map(
      (s) => bp(s, s, 'get-in'),
    );
    expect(entriesOf(items).map((e) => e.id.replace(/^.*starter-/, ''))).toEqual([
      'access-card',
      'monthly-pass',
      'day-pass',
      'guest-pass',
      'timed-ticket',
    ]);
  });
});
