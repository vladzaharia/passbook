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
    expect(stage?.style.getPropertyValue('--pc-glow')).toBe(view.colors.background);
    expect(stage?.style.viewTransitionName).toBe('pass-1');
  });

  it('flips without script on SSR pages', () => {
    const html = renderToStaticMarkup(<PassCardStage view={view} toggleId="flip" tilt={false} />);
    expect(html).toContain('<input id="flip" type="checkbox" class="pc-flip-toggle');
    expect(html).toContain('<label for="flip" class="pc-flip-label">Show back</label>');
    expect(html).not.toContain('inert');
  });
});
