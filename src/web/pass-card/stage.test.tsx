import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { assets, generic } from '../../shared/pass-view/fixtures/index.ts';
import { normalize } from '../../shared/pass-view/index.ts';
import './sync-barcode.ts';
import { PassCardStage } from './index.tsx';

const view = normalize(generic, {
  assets,
  now: new Date('2026-10-31T12:00:00Z'),
  timeZone: 'UTC',
});

describe('PassCardStage', () => {
  it('renders one face unless flippable', () => {
    const { container } = render(<PassCardStage view={view} />);
    expect(container.querySelectorAll('.pc-face')).toHaveLength(1);
    expect(container.querySelector('.pc-stage')).toHaveAttribute('data-single');
  });

  it('keeps the far face out of the tab order and passes axe', async () => {
    const { container, rerender } = render(<PassCardStage view={view} flippable />);
    const face = (side: string) => container.querySelector(`.pc-face[data-side="${side}"]`);
    expect(face('front')).not.toHaveAttribute('inert');
    expect(face('back')).toHaveAttribute('inert');
    rerender(<PassCardStage view={view} flippable face="back" />);
    expect(face('front')).toHaveAttribute('inert');
    expect(screen.getByRole('link', { name: 'terms' })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('sets the glow colour and the shared transition name', () => {
    const { container } = render(<PassCardStage view={view} transitionName="pass-1" />);
    const stage = container.querySelector<HTMLElement>('.pc-stage');
    // The fixture's navy is darker than .12 luminance, so its label colour lights the glow.
    expect(stage?.style.getPropertyValue('--pc-glow')).toBe(
      `color-mix(in srgb, ${view.colors.label} 60%, ${view.colors.background})`,
    );
    expect(stage?.style.viewTransitionName).toBe('pass-1');
  });

  it('flips without script on SSR pages through a Front / Details pair', () => {
    const html = renderToStaticMarkup(<PassCardStage view={view} toggleId="flip" tilt={false} />);
    expect(html).toMatch(/<input id="flip-front" type="radio"[^>]*name="flip"[^>]*checked=""/);
    expect(html).toMatch(/<input id="flip" type="radio" class="pc-flip-toggle pc-sr" name="flip"/);
    expect(html).toContain(
      '<label for="flip-front">Front</label><label for="flip">Details</label>',
    );
    expect(html).not.toContain('inert');
  });

  it('glows in the pass colour when it is light enough', () => {
    const light = normalize({ ...generic, backgroundColor: 'rgb(220, 120, 40)' }, { assets });
    const { container } = render(<PassCardStage view={light} />);
    const stage = container.querySelector<HTMLElement>('.pc-stage');
    expect(stage?.style.getPropertyValue('--pc-glow')).toBe('rgb(220, 120, 40)');
  });

  it('reserves the sync rail and only runs it while syncing', () => {
    const { container, rerender } = render(<PassCardStage view={view} syncing />);
    const rail = () => container.querySelector('.pc-sync-rail');
    expect(rail()).toHaveAttribute('data-on');
    rerender(<PassCardStage view={view} syncing={false} />);
    expect(rail()).not.toBeNull();
    expect(rail()).not.toHaveAttribute('data-on');
    rerender(<PassCardStage view={view} />);
    expect(rail()).toBeNull();
  });

  it('does not mint across a paused (undefined) value, and mints on a new one', () => {
    const lift = (c: HTMLElement) => c.querySelector('.pc-lift') as HTMLElement;
    const { container, rerender } = render(<PassCardStage view={view} mint={1} />);
    rerender(<PassCardStage view={view} mint={undefined} />);
    rerender(<PassCardStage view={view} mint={1} />);
    expect(lift(container).dataset.mint).toBeUndefined();
    rerender(<PassCardStage view={view} mint={undefined} />);
    rerender(<PassCardStage view={view} mint={2} />);
    expect(lift(container).dataset.mint).toBe('');
  });

  it('enters voided passes quietly and without tilt', () => {
    const { container } = render(<PassCardStage view={view} enter dim />);
    const stage = container.querySelector('.pc-stage');
    expect(stage).toHaveAttribute('data-enter', 'quiet');
    expect(stage).not.toHaveAttribute('data-tilt');
  });
});
