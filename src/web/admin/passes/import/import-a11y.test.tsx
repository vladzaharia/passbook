import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { membershipFixture, renderApp } from '../../../lib/test-utils.tsx';
import { baseHandlers, checked, finished, importDto, json, ORG } from './import-test-fixtures.ts';

const membership = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const WIDTHS = [1440, 820, 390] as const;
const THEMES = ['light', 'dark'] as const;

/** Axe at each width and theme: the width drives the viewport classes, the theme the data-theme stamp. */
async function axeEverywhere(root: HTMLElement) {
  for (const width of WIDTHS)
    for (const theme of THEMES) {
      window.innerWidth = width;
      window.dispatchEvent(new Event('resize'));
      document.documentElement.dataset.theme = theme;
      expect((await axe(root)).violations, `${width}px ${theme}`).toEqual([]);
    }
}

afterEach(() => {
  delete document.documentElement.dataset.theme;
  window.innerWidth = 1024;
  vi.restoreAllMocks();
});

async function open(path: string, imp?: Record<string, unknown>) {
  return renderApp(path, {
    session: 'admin',
    memberships: [membership],
    selectedOrg: ORG.id,
    handlers: {
      ...baseHandlers(),
      ...(imp ? { '/api/v1/pass-imports/imp1': () => json(imp) } : {}),
    },
  });
}

describe('import screens pass axe at 1440, 820 and 390, in both themes', () => {
  it('source', async () => {
    const { container } = await open('/admin/passes/import');
    await screen.findByRole('button', { name: 'Next' });
    await axeEverywhere(container);
  });

  it('match columns', async () => {
    const { container } = await open('/admin/passes/import/imp1', importDto());
    await screen.findByRole('heading', { name: 'Match the columns' });
    await axeEverywhere(container);
  });

  it('check, with problems', async () => {
    const { container } = await open('/admin/passes/import/imp1', checked());
    await screen.findByRole('button', { name: /Needs a fix/ });
    await axeEverywhere(container);
  });

  it('progress', async () => {
    const { container } = await open(
      '/admin/passes/import/imp1',
      importDto({
        state: 'committing',
        plan: checked().plan,
        counts: checked().counts,
        committedAt: 1,
        progress: {
          done: 12,
          created: 12,
          updated: 0,
          unchanged: 0,
          failed: 0,
          notEmailed: 0,
          removed: 0,
        },
      }),
    );
    await screen.findByText(/12 of 160/);
    await axeEverywhere(container);
  });

  it('results', async () => {
    const { container } = await open('/admin/passes/import/imp1', finished());
    await screen.findByText('Created');
    await axeEverywhere(container);
  });

  it('an expired import', async () => {
    const { container } = await open('/admin/passes/import/imp1', importDto({ state: 'expired' }));
    await screen.findByText(/no longer available/);
    await axeEverywhere(container);
  });
});
