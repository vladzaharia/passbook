import { afterEach, describe, expect, it } from 'vitest';
import { pointWorkbenchLink } from './workbench-link.ts';

const bar = () => {
  document.body.innerHTML =
    '<a data-wb-link href="/workbench/quickstart"><span data-wb-label>Workbench</span></a>';
  const a = document.querySelector<HTMLAnchorElement>('[data-wb-link]');
  if (!a) throw new Error('no link');
  return a;
};

afterEach(() => history.replaceState(null, '', '/'));

describe('the companion link', () => {
  it('keeps Quickstart signed out', () => {
    const a = bar();
    pointWorkbenchLink(false);
    expect(a.getAttribute('href')).toBe('/workbench/quickstart');
    expect(a.textContent).toBe('Workbench');
  });

  it('goes to the Workbench for a signed-in reader', () => {
    const a = bar();
    pointWorkbenchLink(true);
    expect(a.getAttribute('href')).toBe('/workbench');
    expect(a.textContent).toBe('Workbench');
  });

  it('reads Back to Workbench after coming from it', () => {
    history.replaceState(null, '', '/developers/guides?from=workbench');
    const a = bar();
    pointWorkbenchLink(false);
    expect(a.getAttribute('href')).toBe('/workbench');
    expect(a.textContent).toBe('Back to Workbench');
  });
});
