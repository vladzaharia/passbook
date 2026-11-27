import { describe, expect, it } from 'vitest';
import { applyGate } from './gate.ts';

const page = () => {
  const el = document.createElement('div');
  el.innerHTML =
    '<p class="qs-empty">Sign in to see your pass here.</p><ol><li data-step="1"><div class="qs-body"><h2 class="qs-h"><span>Sign in</span></h2><p>line</p><p><a class="btn" href="/x">go</a></p></div></li></ol>';
  return el;
};

describe('quickstart step 1 gate', () => {
  it('leaves signed out as prerendered', () => {
    const el = page();
    const before = el.innerHTML;
    applyGate(el, { reason: 'none', email: null });
    expect(el.innerHTML).toBe(before);
  });

  it('asks an email session for Polaris ID', () => {
    const el = page();
    applyGate(el, { reason: 'email', email: 'a@b.test' });
    expect(el.querySelector('.qs-h')?.textContent).toBe('Use Polaris ID');
    expect(el.textContent).toContain('Email links open My passes only.');
    expect(el.querySelector('a.btn')?.getAttribute('href')).toContain('/auth/oidc/start?next=');
  });

  it('says there is no developer access, with who is signed in', () => {
    const el = page();
    applyGate(el, { reason: 'noaccess', email: 'a@b.test' });
    expect(el.querySelector('.qs-h')?.textContent).toBe('No developer access');
    expect(el.querySelector('.qs-empty')).toBeNull();
    expect(el.textContent).toContain('An organization admin can invite you as a developer.');
    expect(el.textContent).toContain('Signed in as a@b.test');
    expect([...el.querySelectorAll('a')].map((a) => a.textContent)).toEqual([
      'Use another Polaris ID',
      'My passes',
    ]);
    expect(el.querySelector('button')?.textContent).toBe('Copy request');
    expect(el.querySelector('a.btn.outline')?.textContent).toBe('Use another Polaris ID');
  });

  it('names the orgs that invited the signed-in address', () => {
    const el = page();
    applyGate(el, { reason: 'noaccess', email: 'a@b.test', invitedBy: ['Acme Passes'] });
    expect(el.textContent).toContain(
      'Acme Passes invited you. Open the invitation email to finish.',
    );
    expect(el.textContent).not.toContain('can invite you as a developer');
  });

  it('offers no request without an email', () => {
    const el = page();
    applyGate(el, { reason: 'noaccess', email: null });
    expect(el.querySelector('button')).toBeNull();
  });
});
