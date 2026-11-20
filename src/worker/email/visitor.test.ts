import { describe, expect, it } from 'vitest';
import { visitorArrivalEmail } from './visitor.ts';

const at = Date.UTC(2026, 10, 25, 14, 12);
const mail = (name = 'Leo Park') =>
  visitorArrivalEmail({
    name,
    place: 'Reception',
    at,
    timeZone: 'America/New_York',
    base: 'https://wallet.test',
  });

describe('visitorArrivalEmail', () => {
  it('names the visitor, the door and the time in the door zone', () => {
    const m = mail();
    expect(m.subject).toBe('Leo Park is here');
    expect(m.text).toBe('Leo Park is here.\n\nReception, 9:12 AM EST.');
    expect(m.html).toContain('Leo Park is here.');
  });

  it('escapes the visitor name in the page and keeps the subject to one line', () => {
    const m = mail('<b>Eve</b>');
    expect(m.html).not.toContain('<b>Eve</b>');
    expect(m.html).toContain('&lt;b&gt;Eve&lt;/b&gt;');
  });

  it('falls back to UTC for a zone it does not know', () => {
    expect(mail().text).toContain('Reception');
    const bad = visitorArrivalEmail({
      name: 'Leo',
      place: 'Desk',
      at,
      timeZone: 'Not/AZone',
      base: 'https://wallet.test',
    });
    expect(bad.text).toContain('2:12 PM UTC');
  });
});
