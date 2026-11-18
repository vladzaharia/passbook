import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import '../lib/test-utils.tsx';
import { TAG_SCENARIOS, TagVisual } from './visual-tags.tsx';

describe('tag scenarios', () => {
  for (const width of [390, 820, 1180]) {
    for (const theme of ['light', 'dark']) {
      it.each(TAG_SCENARIOS)(`%s at ${width} px, ${theme}: no axe violations`, async (scenario) => {
        document.documentElement.dataset.theme = theme;
        Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
        const { container, unmount } = render(
          <div style={{ width }}>
            <TagVisual scenario={scenario} />
          </div>,
        );
        expect((await axe(container)).violations).toEqual([]);
        unmount();
        delete document.documentElement.dataset.theme;
      });
    }
  }

  it('every error and request scenario has one level-one heading to move focus to', () => {
    for (const scenario of TAG_SCENARIOS.filter(
      (s) => s.startsWith('assign-') || s.startsWith('request-card'),
    )) {
      const { unmount } = render(<TagVisual scenario={scenario} />);
      expect(screen.getAllByRole('heading', { level: 1 }).length, scenario).toBe(1);
      unmount();
    }
  });
});
