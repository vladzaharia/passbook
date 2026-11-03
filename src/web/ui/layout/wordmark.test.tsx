import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderApp } from '../../lib/test-utils.tsx';

afterEach(() => vi.unstubAllGlobals());

/** The buddy's face, decorative: three passes, two eyes (one winks), a smile. */
function expectFace(link: HTMLElement, size: 'size-5' | 'size-6' = 'size-5') {
  const svgs = link.querySelectorAll(':scope > svg');
  expect(svgs).toHaveLength(1);
  const mark = svgs[0] as SVGSVGElement;
  expect(mark).toHaveClass('wl-mark', 'text-accent-fg', size);
  expect(mark).toHaveAttribute('aria-hidden', 'true');
  expect(mark).toHaveAttribute('viewBox', '0 0 20 20');
  expect(mark.querySelectorAll('[data-p]')).toHaveLength(3);
  expect(mark.querySelectorAll('circle')).toHaveLength(2);
  expect(mark.querySelectorAll('[data-wink]')).toHaveLength(1);
  expect(mark.querySelector('.lucide')).toBeNull();
  return mark;
}

describe('every wordmark wears the face', () => {
  it('in the admin sidebar and the nav sheet, which never says hello', async () => {
    await renderApp('/admin', { session: 'admin' });
    const [sidebar] = await screen.findAllByRole('link', { name: 'PassBook' });
    expect(sidebar).toHaveAttribute('href', '/admin');
    expectFace(sidebar as HTMLElement);
    await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const sheet = await screen.findByRole('dialog');
    const mark = expectFace(within(sheet).getByRole('link', { name: 'PassBook' }));
    expect(mark).not.toHaveAttribute('data-hello');
  });

  it('in the portal header: the face alone on pass views, named Home', async () => {
    const { container } = await renderApp('/', { session: 'user' });
    const home = await screen.findByRole('link', { name: 'Home' });
    expect(home).toHaveAttribute('href', '/');
    expectFace(home);
    expect(home).not.toHaveTextContent('PassBook');
    expect((await axe(container.querySelector('header') as HTMLElement)).violations).toEqual([]);
  });

  it('in the portal header beside the word elsewhere', async () => {
    await renderApp('/account', { session: 'user' });
    expectFace(await screen.findByRole('link', { name: 'PassBook' }));
  });

  it('on the sign-in band at 24 px', async () => {
    await renderApp('/login', { session: 'anon' });
    const band = (await screen.findByLabelText('Email')).ownerDocument.querySelector(
      '.wl-login-brand',
    ) as HTMLElement;
    expectFace(within(band).getByRole('link', { name: 'PassBook' }), 'size-6');
  });

  it('on the standalone error page', async () => {
    await renderApp('/', {
      handlers: { '/api/v1/session': () => new Response('boom', { status: 500 }) },
    });
    await screen.findByRole('alert');
    expectFace(screen.getByRole('link', { name: 'PassBook' }));
  });
});
