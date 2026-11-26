import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CodeBlock } from './code-block.tsx';

const codes = [
  { lang: 'curl', label: 'curl', code: 'curl x' },
  { lang: 'ts', label: 'TypeScript', code: 'fetch(x)' },
  { lang: 'py', label: 'Python', code: 'requests.get(x)' },
  { lang: 'go', label: 'Go', code: 'http.Get(x)' },
] as const;

describe('the quickstart code block', () => {
  const view = (onLang = vi.fn()) =>
    render(
      <CodeBlock
        codes={[...codes]}
        lang="ts"
        onLang={onLang}
        lit={[]}
        base="create"
        name="Create pass"
      />,
    );

  it('holds only tabs in the tablist, with one Copy outside it', () => {
    view();
    const list = screen.getByRole('tablist', { name: 'Language' });
    expect(list.querySelectorAll('button:not([role="tab"])')).toHaveLength(0);
    expect(screen.getAllByRole('button', { name: 'Copy sample' })).toHaveLength(1);
  });

  it('badges the open language while its SDK is unpublished, with a unique region label', () => {
    view();
    expect(screen.getByText('SDK preview')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Create pass: TypeScript sample' })).toBeTruthy();
  });

  it('arrow keys move between tabs', async () => {
    const onLang = vi.fn();
    view(onLang);
    screen.getByRole('tab', { name: 'TypeScript' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onLang).toHaveBeenCalledWith('py');
  });
});
