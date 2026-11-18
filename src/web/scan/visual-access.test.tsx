import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import '../lib/test-utils.tsx';
import { ACCESS_SCENARIOS, AccessVisual } from './visual-access.tsx';

describe('access and occupancy scenarios', () => {
  for (const width of [390, 820, 1180]) {
    for (const theme of ['light', 'dark']) {
      it.each(ACCESS_SCENARIOS)(
        `%s at ${width} px, ${theme}: no axe violations`,
        async (scenario) => {
          document.documentElement.dataset.theme = theme;
          Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
          const { container, unmount } = render(
            <div style={{ width }}>
              <AccessVisual scenario={scenario} />
            </div>,
          );
          if (scenario.startsWith('inside') && scenario !== 'inside-offline')
            await screen.findByRole('dialog');
          const target = scenario.startsWith('inside') ? screen.getByRole('dialog') : container;
          expect((await axe(target)).violations).toEqual([]);
          unmount();
          delete document.documentElement.dataset.theme;
        },
      );
    }
  }
});
