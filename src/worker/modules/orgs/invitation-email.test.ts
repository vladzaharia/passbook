import { describe, expect, it } from 'vitest';
import { invitationEmail } from './invitation-email.ts';

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
});
