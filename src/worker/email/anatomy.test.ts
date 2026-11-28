import { describe, expect, it } from 'vitest';
import { accessRequestEmail } from './access-request.ts';
import { renderBundleEmail } from './bundle.ts';
import { identityLinkedEmail } from './identity-linked.ts';
import { orgClosedEmail, orgReopenedEmail } from './org-closed.ts';
import { renderPassEmail } from './pass.ts';
import { pinDigestEmail, pinOrgCapEmail } from './pin-digest.ts';
import { pinOnlyOffEmail } from './pin-only-off.ts';
import { renderReplyToConfirm } from './reply-to-confirm.ts';
import { renderSignInEmail } from './sign-in.ts';
import { templateReviewEmail } from './template-review.ts';

const BASE = 'https://w.test';
const ORG = 'Northside Climbing';

const pass = (over = {}) =>
  renderPassEmail({
    orgName: ORG,
    downloadUrl: `${BASE}/p/t/pass.pkpass`,
    printUrl: `${BASE}/p/t/print`,
    manageUrl: `${BASE}/p/t`,
    badgeUrl: `${BASE}/apple/badge/en/black@2x.png`,
    attached: true,
    buddyBase: BASE,
    ...over,
  });
const signIn = (over = {}) =>
  renderSignInEmail({
    purpose: 'sign_in',
    link: `${BASE}/auth/magic?t=abc`,
    base: BASE,
    code: '123456',
    expiresMinutes: 15,
    ...over,
  });

/** Every listed email, with the buddy on where the email has one. */
const EMAILS: Record<string, { html: string; buddy: boolean }> = {
  'sign-in': { html: signIn().html, buddy: true },
  'sign-in code first': { html: signIn({ prefer: 'code' }).html, buddy: true },
  'confirm email': {
    html: signIn({ purpose: 'verify_email', code: undefined, requester: 'ada@example.test' }).html,
    buddy: true,
  },
  pass: { html: pass().html, buddy: true },
  'pass without art': { html: pass({ buddyBase: null }).html, buddy: false },
  bundle: {
    html: renderBundleEmail({
      orgName: ORG,
      bundleName: 'Family trip',
      pageUrl: `${BASE}/b/t`,
      addAllUrl: `${BASE}/b/t/passes.pkpasses`,
      badgeUrl: `${BASE}/apple/badge/en/black@2x.png`,
      buddyBase: BASE,
      passes: [
        { title: 'Mia', addUrl: `${BASE}/b/t/p1/pass.pkpass` },
        { title: 'Sam', addUrl: `${BASE}/b/t/p2/pass.pkpass` },
      ],
    }).html,
    buddy: true,
  },
  'org closed': { html: orgClosedEmail(BASE, ORG, 'Jan 3').html, buddy: true },
  'org reopened': { html: orgReopenedEmail(BASE, ORG).html, buddy: true },
  'identity linked': { html: identityLinkedEmail(BASE).html, buddy: true },
  'pin digest': { html: pinDigestEmail(BASE, ORG, ['PIN shared.']).html, buddy: true },
  'pin cap': { html: pinOrgCapEmail(BASE, ORG).html, buddy: true },
  'pin only off': { html: pinOnlyOffEmail(BASE, ORG).html, buddy: true },
  'reply-to': {
    html: renderReplyToConfirm({ orgName: ORG, address: 'hi@gym.test', link: `${BASE}/c/t` }).html,
    buddy: false,
  },
  'template review': {
    html: templateReviewEmail({
      base: BASE,
      link: `${BASE}/t`,
      template: 'Day pass',
      version: '2',
      by: 'Ada',
    }).html,
    buddy: true,
  },
  'access request': {
    html: accessRequestEmail({
      name: 'Ada',
      email: 'ada@example.test',
      org: ORG,
      purpose: 'Memberships',
      message: '',
    }).html,
    buddy: false,
  },
};

/** Word-only fallbacks sit in `[if mso]` comments and repeat the button. */
const visible = (html: string) => html.replace(/<!--\[if mso\]>[\s\S]*?<!\[endif\]-->/g, '');

describe('email anatomy', () => {
  describe.each(Object.entries(EMAILS))('%s', (_name, { html, buddy }) => {
    it('has one title', () => {
      expect(visible(html).match(/<h1[\s>]/g)).toHaveLength(1);
    });

    it('has at most one button', () => {
      expect(visible(html).match(/<a class="e-(btn|block)"/g)?.length ?? 0).toBeLessThanOrEqual(1);
    });

    it('draws the buddy at 96 px, or not at all', () => {
      const imgs = [...html.matchAll(/<img [^>]*src="[^"]*\/email\/buddy-[^>]*>/g)].map(
        (m) => m[0],
      );
      if (!buddy) return expect(imgs).toEqual([]);
      expect(imgs).toHaveLength(2);
      for (const img of imgs) {
        expect(img).toContain('width="96"');
        expect(img).toContain('style="display:block;width:96px;');
      }
    });

    it('answers dark clients through the shared block', () => {
      expect(html).toContain('@media (prefers-color-scheme:dark)');
      expect(html).toContain('.e-page{background:');
    });
  });
});
