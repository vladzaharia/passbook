import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PassJson } from '../../passkit/types.ts';
import { MAC_REVEAL_SCRIPT } from '../../shared/device.ts';
import { assets, fixtures } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import { Back } from '../pass-card/back.tsx';
import { PassDetails } from './pass-details.tsx';

const NOW = new Date('2026-10-31T12:00:00Z');
const view = (json: PassJson) => normalize(json, { assets, now: NOW, timeZone: 'UTC' });

/** Every label, value and action the element shows, as text. */
const items = (root: Element) =>
  [...root.querySelectorAll('.pc-item, .pc-action, .pc-up-name')].map((el) =>
    (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );

/** A generic pass with everything the face cannot hold: a 5th secondary, extra aux, info, links. */
const crowded: PassJson = {
  ...fixtures.generic,
  generic: {
    ...(fixtures.generic.generic as object),
    secondaryFields: ['a', 'b', 'c', 'd', 'e'].map((k) => ({
      key: `s${k}`,
      label: `S ${k}`,
      value: k,
    })),
    auxiliaryFields: ['f', 'g', 'h', 'i', 'j'].map((k) => ({
      key: `x${k}`,
      label: `X ${k}`,
      value: k,
    })),
    additionalInfoFields: [{ key: 'info', label: 'Locker', value: 'B12' }],
    backFields: [
      { key: 'site', label: 'Website', value: 'https://example.com/help' },
      { key: 'track', label: 'Order status updates', value: 'By email' },
    ],
  },
} as PassJson;

describe('PassDetails: the card’s back on the page', () => {
  it.each([...Object.entries(fixtures), ['crowded', crowded]] as [string, PassJson][])(
    '%s: lists exactly what the card’s back lists',
    (_name, json) => {
      const v = view(json);
      const back = render(<Back view={v} layout={v.layouts[v.target]} />).container;
      const { expirationDate: _drop, ...noExpiry } = json as PassJson & { expirationDate?: string };
      const details = render(
        <PassDetails passJson={noExpiry} view={v} locale="en-US" now={NOW} timeZone="UTC" />,
      ).container;
      expect(items(details)).toEqual(items(back));
    },
  );

  it('keeps the face’s overflow, additional info, links and any status-like label', () => {
    const v = view(crowded);
    const { container } = render(
      <PassDetails passJson={crowded} view={v} locale="en-US" now={NOW} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('S e');
    expect(text).toContain('Locker');
    expect(text).toContain('Order status updates');
    expect(container.querySelector('a[href="https://example.com/help"]')).not.toBeNull();
    // Not the face's own fields.
    expect(text).not.toContain('S a');
  });

  it('heads its section with an h2 for the outline, invisible', () => {
    const v = view(crowded);
    const { container } = render(
      <PassDetails passJson={crowded} view={v} locale="en-US" now={NOW} />,
    );
    const h2 = container.querySelector('h2');
    expect(h2).toHaveClass('sr-only');
    expect(container.querySelector('section')).toHaveAttribute('aria-labelledby', h2?.id);
  });

  it('is nothing when the card’s back has nothing to add', () => {
    const bare = {
      ...fixtures.generic,
      generic: { primaryFields: [{ key: 'n', label: 'Name', value: 'A' }] },
    } as PassJson;
    const { container } = render(
      <PassDetails passJson={bare} view={view(bare)} locale="en-US" now={NOW} />,
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('MAC_REVEAL_SCRIPT', () => {
  const run = (ua: string, touch: number) => {
    document.body.innerHTML = '<div data-mac-only hidden>badge</div>';
    Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: touch, configurable: true });
    new Function(MAC_REVEAL_SCRIPT)();
    return (document.querySelector('[data-mac-only]') as HTMLElement).hidden;
  };
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15';

  it('shows the Mac-only parts on a Mac and keeps them hidden on an iPad', () => {
    expect(run(MAC, 0)).toBe(false);
    expect(run(MAC, 5)).toBe(true);
  });
});
