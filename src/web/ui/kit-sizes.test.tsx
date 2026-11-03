import { readFileSync } from 'node:fs';
import type { ColumnDef } from '@tanstack/react-table';
import { render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { generic } from '@/shared/pass-view/fixtures/index.ts';
import { normalize } from '@/shared/pass-view/index.ts';
import '../lib/test-utils.tsx';
import { PassCardStage } from '../pass-card/stage.tsx';
import { Button, buttonVariants } from './button.tsx';
import { Card, CardHeader } from './card.tsx';
import { DataTable } from './data-table.tsx';
import { FormField } from './field.tsx';
import { IconButton } from './icon-button.tsx';
import { CONTROL, Input } from './input.tsx';
import { PassSideToggle } from './pass-toggles.tsx';
import { SegmentedControl } from './segmented-control.tsx';
import { TooltipProvider } from './tooltip.tsx';

const read = (path: string) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const block = (css: string, selector: string) =>
  css.match(new RegExp(`${selector.replace(/[[\]"().>]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('control sizes', () => {
  it('gives every button size 14 px text and 44 px on touch', () => {
    for (const size of ['sm', 'md', 'badge'] as const) {
      const classes = buttonVariants({ size }).split(' ');
      expect(classes, size).toContain('text-sm');
      expect(classes, size).toContain('pointer-coarse:min-h-11');
      expect(classes, size).not.toContain('text-xs');
    }
    expect(buttonVariants({ size: 'sm' })).toContain('min-h-8');
    expect(buttonVariants({ size: 'badge' })).toContain('min-h-10');
  });

  it('sizes icon buttons to 44 on touch, and to the Apple badge with size badge', () => {
    render(
      <TooltipProvider>
        <IconButton label="Row actions" size="sm" icon={<span />} />
        <IconButton label="Refresh" size="badge" variant="outline" icon={<span />} />
      </TooltipProvider>,
    );
    const row = screen.getByRole('button', { name: 'Row actions' });
    expect(row.className).toContain('size-8');
    expect(row.className).toContain('pointer-coarse:size-11');
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    expect(refresh.className).toContain('size-10');
    expect(refresh.className).toContain('pointer-coarse:size-11');
  });
});

describe('SegmentedControl', () => {
  const css = read('src/web/pass-card/stage-seg.css');

  it('has one size, shared with the SSR side toggle', () => {
    const track = block(css, '.wl-seg,\n.pc-seg');
    const item = block(css, '.wl-seg > [role="radio"],\n.pc-seg label');
    expect(track).toMatch(/padding:\s*2px/);
    expect(track).toMatch(/border-width:\s*1px/);
    // 30 + 2 × 2 padding + 2 × 1 border = 36; touch 38 + 6 = 44.
    expect(item).toMatch(/min-height:\s*1\.875rem/);
    expect(item).toMatch(/font-size:\s*0\.875rem/);
    expect(item).toMatch(/font-weight:\s*500/);
    expect(css).toMatch(
      /@media \(pointer: coarse\) \{\s*\.wl-seg > \[role="radio"\],\s*\.pc-seg label \{\s*min-height:\s*2\.375rem/,
    );
  });

  it('renders the SPA control and the SSR toggle on the shared classes', () => {
    render(<PassSideToggle value="front" onChange={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'Side' });
    expect(group.className).toContain('wl-seg');
    expect(group.className).not.toMatch(/text-xs|min-h-7/);
    const ssr = renderToStaticMarkup(
      <PassCardStage view={normalize(generic, { assets: {} })} toggleId="side" />,
    );
    expect(ssr).toContain('<fieldset class="pc-seg">');
  });

  it('takes no size prop', () => {
    render(
      <SegmentedControl
        label="View"
        value="a"
        onValueChange={() => {}}
        options={[
          { value: 'a', label: 'Gallery' },
          { value: 'b', label: 'Table' },
        ]}
        // @ts-expect-error one size only
        size="sm"
      />,
    );
    expect(screen.getByRole('radiogroup', { name: 'View' })).toBeInTheDocument();
  });
});

describe('CardHeader', () => {
  it('is 48 px tall with or without actions', () => {
    render(
      <Card>
        <CardHeader title="Emails" />
        <CardHeader
          title="Sessions"
          actions={
            <Button size="sm" variant="ghost">
              Sign out everywhere
            </Button>
          }
        />
      </Card>,
    );
    for (const name of ['Emails', 'Sessions']) {
      const header = screen.getByRole('heading', { name }).parentElement;
      expect(header?.className).toContain('min-h-12');
      expect(screen.getByRole('heading', { name }).className).toContain('py-3');
    }
    const actions = screen.getByRole('button', { name: 'Sign out everywhere' }).parentElement;
    // Holds a 44 px touch control inside the 48 px header.
    expect(actions?.className).toContain('min-h-11');
    expect(actions?.className).not.toMatch(/\bpy-/);
  });
});

describe('DataTable', () => {
  it('frames a standalone table with the card surface, and none inside a card', () => {
    const columns: ColumnDef<{ id: string }, never>[] = [{ accessorKey: 'id', header: 'Id' }];
    const { rerender } = render(
      <DataTable caption="Rows" columns={columns} data={[{ id: 'a' }]} />,
    );
    const frame = screen.getByRole('region', { name: 'Rows' });
    for (const c of ['bg-surface-raised', 'border-border', 'rounded-lg']) {
      expect(frame.className).toContain(c);
    }
    expect(frame.className).toContain('shadow-[var(--wl-edge),var(--pk-elevation-1)]');
    rerender(<DataTable caption="Rows" columns={columns} data={[{ id: 'a' }]} bare />);
    expect(screen.getByRole('region', { name: 'Rows' }).className).not.toContain('bg-surface');
  });
});

describe('read-only fields', () => {
  it('drop the editable fill and border, in both themes', () => {
    expect(CONTROL).toContain('[&:is(input,textarea):read-only]:bg-(--wl-field-readonly)');
    expect(CONTROL).toContain('[&:is(input,textarea):read-only]:border-border');
    const tokens = readFileSync('src/web/styles/wallet.css', 'utf8');
    // Dark (the default block) is transparent; both light blocks sink.
    expect(tokens.match(/--wl-field-readonly:\s*([^;]+);/g)).toEqual([
      '--wl-field-readonly: transparent;',
      '--wl-field-readonly: var(--pk-surface-sunken);',
      '--wl-field-readonly: var(--pk-surface-sunken);',
    ]);
  });

  it('hide the required mark when the control cannot be filled in', () => {
    render(
      <FormField label="Offer" required>
        {(p) => <Input {...p} readOnly value="Retired offer" />}
      </FormField>,
    );
    expect(document.querySelector('[data-field] [data-required-mark]')).not.toBeNull();
    const css = readFileSync('src/web/styles/kit-controls.css', 'utf8');
    expect(css).toMatch(
      /\[data-field\]:has\([\s\S]*?:read-only[\s\S]*?\)\s*\[data-required-mark\]\s*\{\s*display: none;/,
    );
  });
});
