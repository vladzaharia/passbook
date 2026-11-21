import { describe, expect, it } from 'vitest';
import { invitationEmail, mailOrgName } from './invitation-email.ts';

const base = {
  orgName: 'Acme',
  link: 'https://x.test/a',
  base: 'https://x.test',
  roles: ['org_admin'],
};

describe('invitation email', () => {
  it('says who invited you and as what, and styles the accept link', () => {
    const mail = invitationEmail({ ...base, acceptLink: 'https://x.test/b', inviter: 'Dana' });
    expect(mail.text).toContain('Dana invited you to Acme as an organization admin.');
    expect(mail.html).toContain('Dana invited you to Acme as an organization admin.');
    expect(mail.html).toMatch(/class="e-link"[^>]*color:#/);
  });

  it('names no one when the inviter has no name', () => {
    expect(invitationEmail(base).text).toContain(
      'You are invited to Acme as an organization admin.',
    );
  });

  it('keeps the organization name out of the subject, and cuts and cleans it in the body', () => {
    const lure = `URGENT\u202e: your account is suspended, sign in at once ${'x'.repeat(80)}`;
    const mail = invitationEmail({ ...base, orgName: lure });
    expect(mail.subject).toBe('You are invited to PassBook');
    expect(mail.subject).not.toContain('URGENT');
    expect(mail.text).not.toContain('\u202e');
    expect(mail.text).not.toContain('x'.repeat(41));
    expect(mail.text).toContain('…');
  });
  it('leaves an ordinary name whole', () => {
    expect(mailOrgName('  North  Gym  ')).toBe('North Gym');
  });
});
