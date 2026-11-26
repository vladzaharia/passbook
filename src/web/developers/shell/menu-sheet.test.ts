import { beforeEach, describe, expect, it } from 'vitest';
import { fillMenuSheet } from './menu-sheet.ts';

const sheet = () => {
  document.body.innerHTML =
    '<nav><div data-menu-sandbox hidden></div><div data-menu-spaces hidden></div><a data-menu-signin href="/login">Sign in</a></nav>';
  return document.body;
};
const all = [
  { space: 'passes', href: '/', current: false },
  { space: 'account', href: '/account', current: false },
  { space: 'admin', href: '/admin', current: false },
  { space: 'developers', href: '/developers', current: true },
] as const;

describe('the menu sheet', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps Sign in and shows no groups until a session fills it', () => {
    const root = sheet();
    expect(root.querySelector<HTMLElement>('[data-menu-signin]')?.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('[data-menu-spaces]')?.hidden).toBe(true);
  });

  it('lists the spaces the session can use, Account left to its menu, the current one marked', () => {
    const root = sheet();
    fillMenuSheet(root, { spaces: all });
    const links = [...root.querySelectorAll<HTMLAnchorElement>('[data-menu-spaces] a')];
    expect(links.map((a) => a.textContent)).toEqual(['My passes', 'Admin', 'Developers']);
    expect(links[2]?.getAttribute('aria-current')).toBe('page');
    expect(root.querySelector<HTMLElement>('[data-menu-signin]')?.hidden).toBe(true);
  });

  it('offers no Spaces group when there is nothing to switch to', () => {
    const root = sheet();
    fillMenuSheet(root, { spaces: [all[3]] });
    expect(root.querySelector<HTMLElement>('[data-menu-spaces]')?.hidden).toBe(true);
  });

  it('names the sandbox and links its Keys in the Workbench', () => {
    const root = sheet();
    fillMenuSheet(root, { spaces: [all[0], all[3]], sandbox: 'a96a2c79' });
    const box = root.querySelector('[data-menu-sandbox]');
    expect(box?.querySelector('h4')?.textContent).toBe('Sandbox a96a2c79');
    expect([...(box?.querySelectorAll('a') ?? [])].map((a) => a.textContent)).toEqual(['Keys']);
    expect(box?.querySelector('a')?.getAttribute('href')).toBe('/workbench/keys');
  });

  it('turns the Sign in slot into Polaris ID for an email-link session', () => {
    const root = sheet();
    fillMenuSheet(root, { spaces: [all[0]], polarisId: '/auth/oidc/start?next=%2Fdevelopers' });
    const link = root.querySelector<HTMLAnchorElement>('[data-menu-signin]');
    expect(link?.hidden).toBe(false);
    expect(link?.textContent).toBe('Sign in with Polaris ID');
    expect(link?.getAttribute('href')).toBe('/auth/oidc/start?next=%2Fdevelopers');
  });
});
