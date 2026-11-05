import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import type { PassJson } from '../../passkit/types.ts';
import { assets, fixtures, generic, posterGeneric } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import './sync-barcode.ts';
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

  it('posterGeneric lays out art, code, title row and two footers without a footer panel', () => {
    const pass: PassJson = {
      ...posterGeneric,
      posterGeneric: {
        headerFields: [{ key: 'k', label: 'KEY TAG', value: '325604493' }],
        primaryFields: [
          { key: 'n', value: 'Member Name' },
          { key: 'p', label: 'Pass', value: 'Membership' },
        ],
        footerFields: [
          { key: 'f', value: 'Henry’s Gymnasium' },
          { key: 'g', value: 'Hidden' },
        ],
      },
    };
    const { container } = render(<PassCard view={view(pass)} />);
    const low = container.querySelector('.pc-poster-low') as HTMLElement;
    const parts = [...low.children].map((e) => e.className);
    expect(parts[0]).toContain('pc-code');
    expect(parts[1]).toContain('pc-poster-primary');
    expect(parts[2]).toContain('pc-poster-footer');
    expect(container.querySelector('.pc-poster-primary .pc-title')).toHaveTextContent(
      'Member Name',
    );
    expect(container.querySelector('.pc-poster-primary .pc-label')).toHaveTextContent('Pass');
    expect(container.querySelectorAll('.pc-poster-footer .pc-field')).toHaveLength(2);
    expect(container.querySelector('.pc-art-top')).toHaveTextContent('KEY TAG');
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
    await user.click(screen.getByRole('button', { name: 'Details' }));
    expect(container.querySelector('.pc-root')).toHaveAttribute('data-face', 'back');
    expect(within(container).getByRole('button', { name: 'Front' })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('truthful front', () => {
  it('renders the colours exactly as given', () => {
    const low = {
      ...generic,
      backgroundColor: 'rgb(50, 60, 70)',
      foregroundColor: 'rgb(60, 70, 80)',
    } as PassJson;
    const { container } = render(<PassCard view={view(low)} />);
    const card = container.querySelector<HTMLElement>('.pc-card');
    expect(card?.style.getPropertyValue('--pc-fg')).toBe('rgb(60, 70, 80)');
  });

  it('steps a long primary value down before truncating and never links the front', () => {
    const long = {
      ...generic,
      generic: {
        primaryFields: [
          { key: 'p', value: 'A primary value that runs on and on and on past fifty' },
        ],
        secondaryFields: [
          {
            key: 's',
            value: 'Read https://example.com',
            attributedValue: '<a href="https://example.com">site</a>',
          },
        ],
      },
    } as PassJson;
    const { container } = render(<PassCard view={view(long)} />);
    expect(container.querySelector('.pc-primary .pc-field')).toHaveAttribute('data-long');
    expect(container.querySelector('.pc-root[data-face="front"] a')).toBeNull();
  });

  it('breaks back emails and URLs only after @, . or /', () => {
    const { container } = render(<PassCard view={view(generic)} face="back" />);
    const mail = container.querySelector('a[href^="mailto:"]');
    expect(mail?.querySelectorAll('wbr').length).toBeGreaterThan(0);
    for (const piece of mail?.querySelectorAll('span') ?? []) {
      expect(piece.textContent).toMatch(/[@./]$/);
    }
  });
});

describe('voided and removed', () => {
  it('stamps a voided pass and greys the card itself', () => {
    const { container } = render(<PassCard view={view({ ...generic, voided: true })} />);
    expect(screen.getByText('Voided')).toBeInTheDocument();
    expect(container.querySelector('.pc-card')).toHaveAttribute('data-voided');
  });

  it('dims a removed pass with no stamp', () => {
    const { container } = render(<PassCard view={view({ ...generic, voided: true })} removed />);
    expect(screen.queryByText('Voided')).toBeNull();
    expect(container.querySelector('.pc-root')).toHaveAttribute('data-removed');
    expect(container.querySelector('.pc-card')).not.toHaveAttribute('data-voided');
  });
});

describe('long primary values', () => {
  it('step down from 8 characters beside a thumbnail, and again past 12', () => {
    const named = (value: string) =>
      view({
        ...generic,
        generic: { primaryFields: [{ key: 'name', label: 'Member', value }] },
      });
    const { container } = render(<PassCard view={named('Member M-006')} />);
    const field = container.querySelector('.pc-primary .pc-field');
    expect(field).toHaveAttribute('data-mid');
    expect(field).not.toHaveAttribute('data-long');
  });
});
