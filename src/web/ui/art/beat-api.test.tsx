import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIM } from './base.tsx';
import { Buddy } from './buddy.tsx';
import { BuddyArt } from './buddy-art.tsx';
import { ART_NAMES, EntityArt, preloadArt } from './index.ts';
import { WalletArt } from './wallet.tsx';

const DIR = join(process.cwd(), 'src/web/ui/art');
const read = (f: string) =>
  readFileSync(join(DIR, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');

afterEach(() => vi.unstubAllGlobals());

describe('xl-scan tier', () => {
  it('is 192 x 144 with a 3 px line, 256 x 192 and 3.25 px from 768', () => {
    expect(DIM['xl-scan']).toEqual([192, 144]);
    const svg = render(<WalletArt size="xl-scan" seat />).container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '192');
    const art = read('art.css');
    expect(art).toContain('.wl-art[data-size="xl-scan"] { --art-w: 3; }');
    expect(art).toMatch(
      /@media \(min-width: 48rem\) \{ \.wl-art\[data-size="xl-scan"\] \{ width: 256px; height: 192px; --art-w: 3\.25; \} \}/,
    );
  });

  it('keeps the seated buddy with a card and a prop slot within 40 nodes', () => {
    const { container } = render(<BuddyArt size="xl-scan" card="in" beat="hop" />);
    expect(container.querySelectorAll('*').length).toBeLessThanOrEqual(40);
  });
});

describe('card', () => {
  it('hides the middle pass and shows the pocket notch, leaving the outer passes', () => {
    const { container } = render(<WalletArt state="login" seat card="out" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('data-card', 'out');
    expect(container.querySelector('[data-part=c1]')).not.toBeNull();
    expect(container.querySelector('[data-part=c3]')).not.toBeNull();
    expect(container.querySelector('[data-part=nt]')).not.toBeNull();
    expect(read('art-wallet.css')).toMatch(
      /\[data-card\] \[data-part="c2"\] \{ visibility: hidden; \}/,
    );
  });

  it('draws no notch without a card', () => {
    const { container } = render(<WalletArt state="login" seat />);
    expect(container.querySelector('[data-part=nt]')).toBeNull();
    expect(container.querySelector('svg')).not.toHaveAttribute('data-card');
  });
});

describe('beat API', () => {
  it('renders beat, pose and dir on the buddy and forwards the prop slots', () => {
    const { container } = render(
      <BuddyArt
        beat="stamp"
        pose="aim"
        dir="out"
        onCard={<i data-t="on" />}
        front={<i data-t="front" />}
        aside={<i data-t="aside" />}
      />,
    );
    const el = container.querySelector('.wl-buddy');
    expect(el).toHaveAttribute('data-beat', 'stamp');
    expect(el).toHaveAttribute('data-pose', 'aim');
    expect(el).toHaveAttribute('data-dir', 'out');
    for (const t of ['on', 'front', 'aside'])
      expect(container.querySelector(`[data-t=${t}]`)).not.toBeNull();
  });

  it('landed is seated at once', () => {
    const { container } = render(<BuddyArt landed />);
    expect(container.querySelector('svg')).toHaveAttribute('data-still');
  });

  it('immediate starts on mount in a layout effect and on every replay change, with no observer', () => {
    const observer = vi.fn();
    vi.stubGlobal('IntersectionObserver', observer);
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    const { container, rerender } = render(<Buddy immediate beat="hop" scene="scan" replay={0} />);
    const el = container.querySelector('.wl-buddy');
    expect(el).toHaveAttribute('data-run');
    expect(rect).toHaveBeenCalledTimes(1);
    rerender(<Buddy immediate beat="hop" scene="scan" replay={1} />);
    expect(rect).toHaveBeenCalledTimes(2);
    expect(el).toHaveAttribute('data-run');
    expect(observer).not.toHaveBeenCalled();
    rect.mockRestore();
  });

  it('immediate has no data-replay and a click does not replay', () => {
    const { container } = render(<Buddy immediate beat="hop" scene="scan" />);
    const el = container.querySelector('.wl-buddy') as HTMLElement;
    expect(el).not.toHaveAttribute('data-replay');
    el.removeAttribute('data-run');
    el.click();
    expect(el).not.toHaveAttribute('data-run');
  });

  it('keeps data-replay without immediate', () => {
    const { container } = render(<Buddy />);
    expect(container.querySelector('.wl-buddy')).toHaveAttribute('data-replay');
  });

  it('never runs under reduced motion', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
    const { container } = render(<Buddy immediate beat="hop" scene="scan" />);
    expect(container.querySelector('.wl-buddy')).not.toHaveAttribute('data-run');
  });
});

describe('scanner entity art', () => {
  it.each(['scanner', 'stub', 'badge'] as const)(
    '%s is registered and within 40 nodes',
    async (name) => {
      expect(ART_NAMES).toContain(name);
      await preloadArt();
      const { container } = render(<EntityArt name={name} />);
      const svg = container.querySelector(`svg[data-art=${name}]`);
      expect(svg).not.toBeNull();
      expect(svg?.querySelectorAll('*').length).toBeLessThanOrEqual(40);
    },
  );
});
