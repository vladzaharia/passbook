/// <reference lib="dom" />
import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import type { PassJson } from '../../passkit/types.ts';
import { assets, fixtures, generic, posterGeneric } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import { PassCard, PassCardFlip } from './index.tsx';

const now = new Date('2026-10-31T12:00:00Z');
const view = (p: PassJson, extra = {}) => normalize(p, { assets, now, timeZone: 'UTC', ...extra });

describe.each(Object.entries(fixtures))('%s', (name, pass) => {
  it('front renders fields, barcode caption and passes axe', async () => {
    const v = view(pass);
    const { container } = render(<PassCard view={v} />);
    const root = container.querySelector('.pc-root');
    expect(root).toHaveAttribute('data-style', v.layout.style);
    expect(screen.getByRole('group')).toHaveAccessibleName(/Example pass, front/);
    expect(screen.getByRole('img', { name: /barcode, approximate rendering/ })).toBeInTheDocument();
    expect(container.querySelector('svg.pc-barcode-svg path')).not.toBeNull();
    for (const f of v.layout.primary) expect(container).toHaveTextContent(f.text);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('back lists back fields with safe links and passes axe', async () => {
    const { container } = render(<PassCard view={view(pass)} face="back" />);
    const link = screen.getByRole('link', { name: 'terms' });
    expect(link).toHaveAttribute('href', 'https://example.com/terms');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(screen.getByRole('link', { name: 'help@example.com' })).toHaveAttribute(
      'href',
      'mailto:help@example.com',
    );
    expect(screen.getByRole('link', { name: /555 010 9999/ })).toHaveAttribute(
      'href',
      'tel:+15550109999',
    );
    expect((await axe(container)).violations).toEqual([]);
    expect(name).toBeTruthy();
  });
});

describe('style specifics', () => {
  it('boardingPass draws the transit glyph between origin and destination', () => {
    const { container } = render(<PassCard view={view(fixtures.boardingPass)} />);
    expect(screen.getByRole('img', { name: 'Flight' })).toBeInTheDocument();
    const route = container.querySelector('.pc-route');
    expect(route).toHaveTextContent('SFO');
    expect(route).toHaveTextContent('HND');
  });

  it('posterGeneric renders the unlabelled first primary as the title', () => {
    render(<PassCard view={view(posterGeneric)} />);
    expect(screen.getByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByText('Downtown')).toBeInTheDocument();
  });

  it('posterGeneric on the legacy target draws generic', () => {
    const { container } = render(<PassCard view={view(posterGeneric)} target="legacy" />);
    expect(container.querySelector('.pc-root')).toHaveAttribute('data-style', 'generic');
  });

  it('featured actions render on the back of an iOS 27 pass only', () => {
    const v = view(posterGeneric);
    const { rerender } = render(<PassCard view={v} face="back" />);
    expect(screen.getByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:+15550109999');
    expect(screen.queryByRole('link', { name: 'Directions' })).toBeNull();
    expect(screen.getByText('Directions')).toBeInTheDocument();
    rerender(<PassCard view={v} face="back" target="legacy" />);
    expect(screen.queryByRole('link', { name: 'Call' })).toBeNull();
  });

  it('uses artwork and logo images with srcset', () => {
    const { container } = render(<PassCard view={view(posterGeneric)} />);
    expect(container.querySelector('img.pc-art-img')).toHaveAttribute('src', '/a/artwork@2x.png');
    const { container: c2 } = render(<PassCard view={view(generic)} />);
    expect(c2.querySelector('img.pc-logo-img')).toHaveAttribute(
      'srcset',
      expect.stringContaining('2x'),
    );
  });

  it('applies pass colors as css variables', () => {
    const { container } = render(<PassCard view={view(generic)} />);
    const card = container.querySelector('.pc-card') as HTMLElement;
    expect(card.style.getPropertyValue('--pc-bg')).toBe('rgb(30, 60, 120)');
    expect(card.style.getPropertyValue('--pc-fg')).toBe('rgb(255, 255, 255)');
  });
});

describe('robustness', () => {
  it('shows an overlay for voided and expired passes', async () => {
    const { container, rerender } = render(<PassCard view={view({ ...generic, voided: true })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Voided');
    rerender(<PassCard view={view({ ...generic, expirationDate: '2026-01-01T00:00:00Z' })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Expired');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('renders no barcode element without one, and a text fallback for bad data', () => {
    const none = view({ ...generic, barcodes: [] });
    const { container, rerender } = render(<PassCard view={none} />);
    expect(container.querySelector('.pc-barcode')).toBeNull();
    const bad = view({
      ...generic,
      barcodes: [{ format: 'PKBarcodeFormatEAN13', message: '12', messageEncoding: 'utf-8' }],
    });
    rerender(<PassCard view={bad} />);
    expect(screen.getByRole('img', { name: 'EAN-13 barcode unavailable' })).toBeInTheDocument();
  });

  it('never creates links or markup from hostile field content', () => {
    const p: PassJson = {
      ...generic,
      organizationName: '<img src=x onerror=alert(1)>',
      generic: {
        primaryFields: [{ key: 'p', value: '<script>alert(1)</script>' }],
        backFields: [
          {
            key: 'b',
            value: 'x',
            attributedValue:
              '<a href="javascript:alert(1)" onclick="x()">click</a><img src=x onerror=alert(1)>',
          },
        ],
      },
    };
    const { container, rerender } = render(<PassCard view={view(p)} />);
    expect(container.querySelector('script, img[onerror]')).toBeNull();
    expect(container).toHaveTextContent('<script>alert(1)</script>');
    rerender(<PassCard view={view(p)} face="back" />);
    expect(container.querySelector('a, script, img[onerror]')).toBeNull();
    expect(container).toHaveTextContent('click');
  });

  it('renders a minimal pass', async () => {
    const { container } = render(
      <PassCard view={view({ ...generic, generic: undefined, barcodes: undefined })} />,
    );
    expect(container.querySelector('.pc-card')).not.toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('puts overflow fields on the back', () => {
    const p: PassJson = {
      ...generic,
      generic: {
        primaryFields: [
          { key: 'a', value: 'one' },
          { key: 'b', label: 'Hidden', value: 'two' },
        ],
      },
    };
    render(<PassCard view={view(p)} face="back" />);
    expect(screen.getByText('Hidden')).toBeInTheDocument();
  });
});

describe('PassCardFlip', () => {
  it('toggles faces with a button', async () => {
    const user = userEvent.setup();
    const { container } = render(<PassCardFlip view={view(generic)} />);
    expect(container.querySelector('.pc-root')).toHaveAttribute('data-face', 'front');
    await user.click(screen.getByRole('button', { name: 'Show back' }));
    expect(container.querySelector('.pc-root')).toHaveAttribute('data-face', 'back');
    expect(within(container).getByRole('button', { name: 'Show front' })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });
});
