import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { formatWallTime } from '../lib/format.ts';
import { membershipsQuery, sessionQuery } from '../lib/session.ts';
import { json, sessionFixture, stubFetch } from '../lib/test-utils.tsx';
import { Callout } from './callout.tsx';
import { DateTimeField } from './date-time-field.tsx';
import { EntityAvatar, EntityChip, EntityIcon, initialsOf, onColor } from './entity.tsx';
import { EntityPicker } from './entity-picker.tsx';
import { FieldGroup, FormGrid, FormSpan } from './form-grid.tsx';
import { Input } from './input.tsx';
import { NumberField } from './number-field.tsx';
import { SegmentedControl } from './segmented-control.tsx';
import { loadTooltips, TooltipProvider } from './tooltip.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

const _wrap = (node: ReactNode) => <TooltipProvider>{node}</TooltipProvider>;

describe('SegmentedControl', () => {
  function Harness() {
    const [v, setV] = useState('front');
    return (
      <SegmentedControl
        label="Side"
        value={v}
        onValueChange={setV}
        options={[
          { value: 'front', label: 'Front' },
          { value: 'details', label: 'Details' },
        ]}
      />
    );
  }

  it('is a radiogroup that arrow keys move through', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    const front = screen.getByRole('radio', { name: 'Front' });
    expect(front).toHaveAttribute('aria-checked', 'true');
    front.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Details' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowRight}');
    expect(front).toHaveAttribute('aria-checked', 'true');
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('Callout', () => {
  it('always shows the tone icon and lists only two or more items', () => {
    const { container, rerender } = render(<Callout tone="warning" items={['One thing']} />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('ul')).toBeNull();
    rerender(<Callout tone="warning" items={['One', 'Two']} />);
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });
});

describe('DateTimeField', () => {
  it('spells the value out, labels zones by city and never shows an IANA id', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container, rerender } = render(
      <DateTimeField
        value={{ local: '2026-11-15T04:08', zone: 'America/Los_Angeles' }}
        onChange={onChange}
        clearLabel="Never expires"
        defaultZone="UTC"
      />,
    );
    expect(formatWallTime('2026-11-15T04:08')).toBe('Nov 15, 2026, 4:08 AM');
    expect(screen.getByText(/Nov 15, 2026, 4:08 AM, Los Angeles/)).toBeInTheDocument();
    expect(container.textContent).not.toContain('America/');
    expect(container.textContent).not.toContain('_');
    await user.click(screen.getByRole('checkbox', { name: 'Never expires' }));
    expect(onChange).toHaveBeenCalledWith(null);
    rerender(
      <DateTimeField
        value={null}
        onChange={onChange}
        clearLabel="Never expires"
        defaultZone="UTC"
      />,
    );
    expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
  });
});

describe('NumberField', () => {
  it('has no spin buttons and puts the unit inside the field', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <NumberField aria-label="Retention" value={30} unit="days" onValueChange={onValueChange} />,
    );
    const input = screen.getByRole('spinbutton', { name: 'Retention' });
    expect(input.className).toContain('appearance:textfield');
    expect(screen.getByText('days')).toBeInTheDocument();
    await user.clear(input);
    expect(onValueChange).toHaveBeenLastCalledWith(null);
  });
});

describe('entity identity', () => {
  it('derives initials, colours and fallbacks', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('maya.chen@example.com')).toBe('MC');
    expect(onColor('#ffffff')).toBe('#060912');
    expect(onColor('#1d4ed8')).toBe('#ffffff');
    const { container } = render(
      <>
        <EntityAvatar kind="user" id="u1" name="Ada Lovelace" size={40} />
        <EntityAvatar kind="org" id="o1" name="Northwind" accent="#2563eb" size={48} />
        <EntityIcon kind="pass" />
        <EntityChip kind="template" id="0190aaaa-bbbb-7ccc-8ddd-eeeeffff0001" />
      </>,
    );
    expect(container.querySelector('[data-initials="AL"]')).not.toBeNull();
    // An org tile shows two initials at every size, and ids give different tile colours.
    const orgs = render(
      <>
        <EntityAvatar kind="org" id="o1" name="Harbor Lights" size={24} />
        <EntityAvatar kind="org" id="o1" name="Harbor Lights" size={40} />
        <EntityAvatar kind="org" id="o2" name="Henry's Gymnasium" size={40} />
      </>,
    ).container;
    const tiles = [...orgs.querySelectorAll('[data-initials]')] as HTMLElement[];
    expect(tiles.map((t) => t.dataset.initials)).toEqual(['HL', 'HL', 'HG']);
    expect(tiles[0]?.style.background).toBe(tiles[1]?.style.background);
    expect(tiles[1]?.style.background).not.toBe(tiles[2]?.style.background);
    expect(container.querySelector('.size-8 svg.size-4')).not.toBeNull();
    // Without a name the chip reads the kind alone, never a slice of the id.
    const chip = screen.getByText('Template');
    expect(chip.textContent).toBe('Template');
    expect(container.textContent).not.toContain('ff0001');
  });
});

describe('EntityPicker', () => {
  it('searches users on the server with q and limit 5', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    stubFetch({
      '/api/v1/users': (url) => {
        seen.push(url.search);
        return json({
          items: [
            {
              id: 'u1',
              name: 'Ada Lovelace',
              primaryEmail: 'ada@example.com',
              status: 'active',
              lastRoles: ['user'],
              createdAt: 1,
              lastLoginAt: null,
            },
          ],
          nextCursor: null,
        });
      },
    });
    const onValueChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQuery.queryKey, sessionFixture('admin'));
    client.setQueryData(membershipsQuery.queryKey, { items: [] });
    const route = createRootRoute({
      component: () => (
        <EntityPicker
          kind="user"
          aria-label="User"
          value={undefined}
          onValueChange={onValueChange}
        />
      ),
    });
    const router = createRouter({ routeTree: route, history: createMemoryHistory() });
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole('combobox', { name: /^User/ }));
    await user.type(await screen.findByPlaceholderText('Search users'), 'ada');
    await user.click(await screen.findByRole('option', { name: 'Ada Lovelace' }));
    expect(onValueChange).toHaveBeenCalledWith('u1');
    expect(seen.at(-1)).toContain('q=ada');
    expect(seen.at(-1)).toContain('limit=5');
  });
});

describe('FormGrid and FieldGroup', () => {
  it('spans long fields and hides a heading that repeats its only label', () => {
    const { container, rerender } = render(
      <FormGrid>
        <FormSpan full>
          <Input aria-label="Notes" />
        </FormSpan>
      </FormGrid>,
    );
    expect(container.querySelector('.col-span-full')).not.toBeNull();
    expect(container.querySelector('.\\@container')).not.toBeNull();
    rerender(
      <FieldGroup title="Links" onlyFieldLabel="Links">
        <Input aria-label="Links" />
      </FieldGroup>,
    );
    expect(screen.queryByRole('heading', { name: 'Links' })).toBeNull();
    rerender(
      <FieldGroup title="Links">
        <Input aria-label="Website" />
      </FieldGroup>,
    );
    expect(screen.getByRole('heading', { name: 'Links' })).toBeInTheDocument();
  });
});

// Last in the file: it loads the Radix tooltip for every test after it.
describe('SegmentedControl off segment', () => {
  function Channels() {
    const [v, setV] = useState('apple');
    return (
      <TooltipProvider delayDuration={0}>
        <SegmentedControl
          label="Channel"
          value={v}
          onValueChange={setV}
          options={[
            { value: 'apple', label: 'Apple' },
            { value: 'paper', label: 'Paper', hint: 'Off for this template' },
          ]}
        />
      </TooltipProvider>
    );
  }

  it('is hatched and quiet with its reason in a tooltip, and chosen like any other', async () => {
    await loadTooltips();
    const user = userEvent.setup();
    const { container } = render(<Channels />);
    const paper = screen.getByRole('radio', { name: 'Paper' });
    expect(paper).toHaveAttribute('data-off');
    expect(paper).not.toHaveAttribute('title');
    expect(paper).toHaveAccessibleDescription('Off for this template');
    expect(paper.className).toContain('text-fg-subtle');
    expect(paper.querySelector('svg')).toBeNull();
    screen.getByRole('radio', { name: 'Apple' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(paper).toBeChecked();
    // Focus says it too: the reason shows as the kit tooltip.
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Off for this template');
    expect(paper.className).toContain('text-fg-strong');
    expect(paper.querySelector('svg')).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });
});
