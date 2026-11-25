import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { BUDDY_MAX } from '../../../shared/copy/developers-buddy.ts';
import { GATE_COPY } from '../../../shared/copy/developers-gate.ts';
import { NotFoundView } from '../pages/not-found.tsx';
import { Gate, signInHref } from './gate.tsx';
import { StateCard } from './state-card.tsx';

describe('Gate', () => {
  it('says what you get and signs in to the page you came from', () => {
    const { getByRole } = render(
      <Gate
        title={GATE_COPY.lines.console}
        next="/developers/console"
        docs="/developers/reference"
      />,
    );
    expect(getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
      '/login?next=%2Fdevelopers%2Fconsole',
    );
    expect(getByRole('link', { name: 'Read the docs' }).getAttribute('href')).toBe(
      '/developers/reference',
    );
    expect(signInHref('/developers/keys')).toBe('/login?next=%2Fdevelopers%2Fkeys');
  });

  it('hides the buddy from assistive tech, and the text carries the message', async () => {
    const { container, getByText } = render(
      <Gate title={GATE_COPY.lines.keys} next="/developers/keys" />,
    );
    expect(container.querySelector('[data-buddy]')?.getAttribute('aria-hidden')).toBe('true');
    expect(getByText(GATE_COPY.lines.keys)).toBeTruthy();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('renders with no script (prerender)', () => {
    const html = renderToString(<Gate title={GATE_COPY.lines.logs} next="/developers/logs" />);
    expect(html).toContain('data-gate');
    expect(html).toContain('Sign in');
  });

  it('keeps every line short and plain', () => {
    for (const line of Object.values(GATE_COPY.lines)) {
      expect(line.length).toBeLessThanOrEqual(BUDDY_MAX);
      expect(line).not.toContain('!');
    }
  });
});

describe('StateCard', () => {
  it('not found: the page h1 with the lens, home and search', () => {
    const { container, getByRole } = render(<NotFoundView />);
    expect(getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(container.querySelector('[data-scene="peek"]')).not.toBeNull();
    expect(container.querySelector('[data-part="ln"]')).not.toBeNull();
    expect(getByRole('link', { name: 'Developers home' }).getAttribute('href')).toBe('/developers');
    expect(getByRole('button', { name: 'Search' }).hasAttribute('data-search')).toBe(true);
  });

  it.each(['empty', 'error', 'lost', 'inspect'] as const)(
    '%s: a named region with the buddy hidden',
    (kind) => {
      const { container } = render(<StateCard kind={kind} title="Nothing here" />);
      expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('Nothing here');
      expect(container.querySelector('[data-buddy]')?.getAttribute('aria-hidden')).toBe('true');
    },
  );
});
