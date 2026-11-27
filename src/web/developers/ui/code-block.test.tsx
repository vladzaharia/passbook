import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Samples } from '../../workbench/events/samples-tabs.tsx';
import type { Sample } from '../model/samples.ts';
import { initCopy } from '../shell/copy.ts';
import { JsonBlock, SampleTabs } from './code.tsx';

const SAMPLES: Sample[] = [
  { lang: 'curl', label: 'curl', file: 'request.sh', code: 'curl one' },
  { lang: 'ts', label: 'TypeScript', file: 'request.ts', code: 'const a = 1;', soon: true },
  { lang: 'py', label: 'Python', file: 'request.py', code: 'a = 1', soon: true },
];

const page = (html: string) => {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
};

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('prerendered blocks', () => {
  it('holds only the language radios in the group and Copy beside it', () => {
    const root = page(renderToStaticMarkup(<SampleTabs id="s" samples={SAMPLES} name="Create" />));
    const group = root.querySelector('[role="radiogroup"]');
    expect(group?.querySelectorAll('input[type="radio"]')).toHaveLength(3);
    expect(group?.querySelector('button')).toBeNull();
    expect(root.querySelectorAll('.code-tools .copy')).toHaveLength(1);
    expect(root.querySelector('.code-f')).toBeNull();
  });

  it('badges a language whose SDK is not published, in text with the tooltip', () => {
    const root = page(renderToStaticMarkup(<SampleTabs id="s" samples={SAMPLES} />));
    const badges = [...root.querySelectorAll('.sdk-badge')];
    expect(badges.map((b) => b.getAttribute('data-badge'))).toEqual(['ts', 'py']);
    expect(badges[0]?.textContent).toContain('SDK preview');
    expect(badges[0]?.getAttribute('title')).toBe('Not published yet. The HTTP call is the same.');
    expect(root.querySelector('.soon-dot')).toBeNull();
  });

  it('Copy as lists each sample and Markdown; region labels carry the name', () => {
    const root = page(renderToStaticMarkup(<SampleTabs id="s" samples={SAMPLES} name="Create" />));
    const items = [...root.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent);
    expect(items).toEqual(['curl', 'TypeScript', 'Python', 'Markdown']);
    expect(root.querySelector('section')?.getAttribute('aria-label')).toBe('Create: curl sample');
  });

  it('a JSON block has the same header: JSON and Copy', () => {
    const root = page(
      renderToStaticMarkup(<JsonBlock json={{ a: 1 }} label="Create: 200 response" />),
    );
    expect(root.querySelector('.code-label')?.textContent).toBe('JSON');
    expect(root.querySelector('.copy')?.getAttribute('aria-label')).toBe('Copy response');
  });

  it('copies exactly the visible sample from a page that holds two blocks', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (t: string) => void written.push(t) },
      configurable: true,
    });
    initCopy();
    document.body.append(
      page(renderToStaticMarkup(<SampleTabs id="s" samples={SAMPLES} />)),
      page(renderToStaticMarkup(<JsonBlock json={{ a: 1 }} label="r" />)),
    );
    const copies = document.querySelectorAll<HTMLElement>('.copy');
    copies[0]?.click();
    await waitFor(() => expect(written).toHaveLength(1));
    copies[1]?.click();
    await waitFor(() => expect(written).toHaveLength(2));
    expect(written[0]).toBe('curl one');
    expect(written[1]).toBe('{\n  "a": 1\n}');
  });
});

describe('webhooks verify block (an island)', () => {
  beforeAll(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async () => {} },
      configurable: true,
    });
  });
  const samples = [
    { id: 'py', label: 'Python', lang: 'py', code: 'one' },
    { id: 'go', label: 'Go', lang: 'go', code: 'two' },
  ] as const;

  it('keeps Copy out of the tablist and opens on the language picked last', async () => {
    localStorage.setItem('passbook-dev-lang', 'go');
    render(<Samples samples={samples} />);
    const list = screen.getByRole('tablist', { name: 'Language' });
    expect(list.querySelectorAll('button:not([role="tab"])')).toHaveLength(0);
    expect(screen.getByRole('tab', { name: 'Go' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.click(screen.getByRole('tab', { name: 'Python' }));
    expect(localStorage.getItem('passbook-dev-lang')).toBe('py');
    expect(screen.getByRole('region', { name: 'Verify: Python sample' })).toBeTruthy();
  });

  it('Copy as offers each language and Markdown', async () => {
    render(<Samples samples={samples} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy as' }));
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual([
      'Python',
      'Go',
      'Markdown',
    ]);
  });
});
