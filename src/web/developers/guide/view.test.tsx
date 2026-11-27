import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../model/samples.ts', () => ({ exampleSamples: () => [] }));
vi.mock('../ui/code.tsx', () => ({
  CodeRegion: ({ label }: { label: string }) => <section aria-label={label} />,
  SampleTabs: ({ id }: { id: string }) => <div data-testid={id} />,
}));
vi.mock('../pages/more.tsx', () => ({ Head: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock('./lifecycle.ts', () => ({ lifecycleSvg: () => '<svg role="img"></svg>' }));

import { GuidesIndex, GuideView, Inline } from './view.tsx';

const guide = (over: Record<string, unknown> = {}) =>
  ({
    meta: { id: 'g1', title: 'Guide one', line: 'One line.', status: 'preview' },
    url: '/developers/guides/g1',
    steps: [{ block: 5, href: '/workbench/console?op=a' }],
    ops: [{ operationId: 'op', method: 'POST', path: '/passes', title: 'Make', href: '/ref/op' }],
    blocks: [
      { kind: 'h2', text: 'Part', id: 'part' },
      { kind: 'h3', text: 'Sub', id: 'sub' },
      { kind: 'p', text: 'Use `code`, **bold** and [a link](/developers/x).' },
      { kind: 'quote', text: 'Note.' },
      { kind: 'ul', items: ['one', 'two'] },
      { kind: 'code', lang: 'json', text: '{"a":1}' },
      { kind: 'ol', items: ['first'] },
      { kind: 'table', head: ['A'], rows: [['b']] },
      { kind: 'run', snippet: 's1' },
      { kind: 'show', snippet: 'missing' },
      { kind: 'diagram', name: 'lifecycle' },
    ],
    ...over,
  }) as never;

describe('Inline', () => {
  it('renders code, bold and links as nodes', () => {
    render(<Inline text="a `b` **c** [d](/developers/x)" />);
    expect(screen.getByText('b').tagName).toBe('CODE');
    expect(screen.getByText('c').tagName).toBe('STRONG');
    expect(screen.getByRole('link', { name: 'd' })).toBeInTheDocument();
  });
});

describe('GuideView', () => {
  it('draws every block, the console link of a step, and the operations', () => {
    render(
      <GuideView
        guide={guide({
          steps: [
            { block: 5, href: '/c#a' },
            { block: 8, href: '/c#b' },
          ],
        })}
        examples={[{ id: 's1', title: 'Run it' } as never]}
        markdown="# md"
      />,
    );
    expect(screen.getByRole('heading', { name: 'Guide one' })).toBeInTheDocument();
    expect(screen.getByText('Preview')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Part' })).toHaveAttribute('id', 'part');
    expect(screen.getByRole('heading', { name: 'Sub' })).toBeInTheDocument();
    expect(screen.getByText('Note.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Step \d+: json request/)).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Run it')).toBeInTheDocument();
    expect(screen.getByTestId('g1-s1-8')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /workbench/i })).toHaveLength(2);
    expect(screen.getByLabelText('Lifecycle diagram')).toBeInTheDocument();
    expect(screen.getByText('/passes')).toBeInTheDocument();
    expect(document.querySelector('[data-copy-text="# md"]')).not.toBeNull();
  });

  it('has no status pill when ready, and no operations section without any', () => {
    render(
      <GuideView
        guide={guide({
          meta: { id: 'g2', title: 'Two', line: 'x', status: 'ready' },
          ops: [],
          blocks: [],
        })}
        examples={[]}
        markdown=""
      />,
    );
    expect(document.querySelector('.pill.accent')).toBeNull();
    expect(document.querySelector('#operations')).toBeNull();
  });
});

describe('GuidesIndex', () => {
  it('lists the guides with their status', () => {
    render(
      <GuidesIndex
        guides={[
          guide(),
          guide({ meta: { id: 'g2', title: 'Two', line: 'x', status: 'soon' }, url: '/g2' }),
          guide({ meta: { id: 'g3', title: 'Three', line: 'y', status: 'ready' }, url: '/g3' }),
        ]}
      />,
    );
    expect(screen.getByText('Guide one')).toBeInTheDocument();
    expect(screen.getByText('Soon')).toBeInTheDocument();
    expect(screen.getByText('Three')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Start' })).toBeInTheDocument();
    expect(document.querySelectorAll('.gtile svg[aria-hidden="true"]')).toHaveLength(3);
  });
});
