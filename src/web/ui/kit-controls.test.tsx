import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { z } from 'zod';
import { json, stubFetch } from '../lib/test-utils.tsx';
import { AppleWalletBadge, appleWalletBadgeHtml } from './apple-wallet-badge.tsx';
import { Callout } from './callout.tsx';
import { JsonViewer } from './code-block.tsx';
import { DateTimeField, formatLocal } from './date-time-field.tsx';
import { EntityAvatar, EntityChip, EntityIcon, initialsOf, onColor } from './entity.tsx';
import { EntityPicker } from './entity-picker.tsx';
import { DATE_RANGES, FilterBar, rangeStart } from './filter-bar.tsx';
import { Form, RhfField, useZodForm } from './form.tsx';
import { FieldGroup, FormGrid, FormSpan } from './form-grid.tsx';
import { Input } from './input.tsx';
import { NumberField } from './number-field.tsx';
import { CopyField, middle, SecretReveal } from './secret-reveal.tsx';
import { SegmentedControl } from './segmented-control.tsx';
import { TooltipProvider } from './tooltip.tsx';
import { confirmWord, TypedConfirmDialog } from './typed-confirm-dialog.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

const wrap = (node: ReactNode) => <TooltipProvider>{node}</TooltipProvider>;

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
    expect(formatLocal('2026-11-15T04:08')).toBe('Nov 15, 2026, 4:08 AM');
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
    expect(container.textContent).toContain('AL');
    expect(container.querySelector('.size-9 svg.size-5')).not.toBeNull();
    expect(screen.getByText('ff0001')).toHaveClass('font-mono');
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
    render(
      <QueryClientProvider client={client}>
        <EntityPicker
          kind="user"
          aria-label="User"
          value={undefined}
          onValueChange={onValueChange}
        />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole('combobox', { name: /^User/ }));
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

describe('Form', () => {
  const schema = z.object({
    name: z.string().min(1, 'Enter a name.'),
    email: z.string().min(1, 'Enter an email.'),
  });

  function Harness() {
    const form = useZodForm(schema, { name: '', email: '' });
    return (
      <Form form={form} onSubmit={() => {}}>
        <RhfField control={form.control} name="name" label="Name" required>
          {(field, c) => <Input {...c} {...field} />}
        </RhfField>
        <RhfField control={form.control} name="email" label="Email" required>
          {(field, c) => <Input {...c} {...field} />}
        </RhfField>
        <button type="submit">Save</button>
      </Form>
    );
  }

  it('focuses the first invalid field and announces one polite summary', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByLabelText(/^Name/)).toHaveFocus());
    const live = container.querySelectorAll('[aria-live="polite"]');
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveTextContent('2 fields need attention');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('TypedConfirmDialog', () => {
  it('picks a human word', () => {
    expect(confirmWord({ title: 'Northwind' })).toBe('Northwind');
    expect(confirmWord({ title: 'A title that is much longer than allowed', slug: 'nw' })).toBe(
      'nw',
    );
    expect(confirmWord({ title: '0190aaaa-bbbb-7ccc-8ddd-eeeeffff0001' })).toBe('delete');
  });

  it('throws in dev for a UUID-shaped word', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(
        <TypedConfirmDialog
          open
          onOpenChange={() => {}}
          title="Delete?"
          word="0190aaaa-bbbb-7ccc-8ddd-eeeeffff0001"
          confirmLabel="Delete"
          onConfirm={async () => {}}
        />,
      ),
    ).toThrow(/human word/);
    vi.restoreAllMocks();
  });

  it('enables only on a matching word, case-insensitive and trimmed, with no X', async () => {
    const user = userEvent.setup();
    render(
      <TypedConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete Northwind?"
        word="Northwind"
        confirmLabel="Delete"
        onConfirm={async () => {}}
      />,
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
    const confirm = within(dialog).getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Type Northwind to confirm'), '  northwind ');
    expect(confirm).toBeEnabled();
    expect(dialog.querySelector('.wl-check')).not.toBeNull();
  });
});

describe('SecretReveal', () => {
  it('masks values, copies from its own column and gates Done on saving', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(
      wrap(
        <SecretReveal
          fields={[{ label: 'API key', value: 'wk_live_abcdefghijklmnopqrstuvwxyz0123456789' }]}
          onDone={onDone}
        />,
      ),
    );
    expect(screen.getByText('Copy the secret now. It is not shown again.')).toBeInTheDocument();
    expect(screen.queryByText(/wk_live/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show API key' }));
    expect(
      screen.getByText(middle('wk_live_abcdefghijklmnopqrstuvwxyz0123456789')),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy API key' })).toBeInTheDocument();
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'I saved the secret' }));
    await user.click(done);
    expect(onDone).toHaveBeenCalled();
  });

  it('truncates in the middle', () => {
    expect(middle('abcdefghijklmnopqrstuvwxyz0123', 4)).toBe('abcd…0123');
    render(wrap(<CopyField label="Short" value="abc" secret={false} />));
    expect(screen.getByText('abc')).toBeInTheDocument();
  });
});

describe('JsonViewer', () => {
  it('tints keys, strings, numbers and booleans', () => {
    const { container } = render(
      wrap(<JsonViewer value={{ name: 'Ada', count: 3, active: true, none: null }} />),
    );
    const tones = new Set([...container.querySelectorAll('[data-token]')].map((s) => s.className));
    expect(tones.size).toBeGreaterThanOrEqual(3);
    expect(container.querySelector('[data-token="key"]')).toHaveTextContent('"name"');
  });
});

describe('AppleWalletBadge', () => {
  it("uses Apple's artwork, switches to outline in dark and never animates", () => {
    const { container, rerender } = render(<AppleWalletBadge href="/p/x/pass.pkpass" />);
    const img = screen.getByRole('img', { name: 'Add to Apple Wallet' });
    expect(img.getAttribute('src')).toMatch(/^\/apple\/badge\/en\/black\.svg$/);
    expect(container.querySelector('source')?.getAttribute('media')).toBe(
      '(prefers-color-scheme: dark)',
    );
    const link = container.querySelector('a');
    expect(link?.className).not.toMatch(/transition|animate|scale|shadow|opacity/);
    expect(getComputedStyle(link as Element).transition || 'none').toMatch(/^(none|all 0s.*|)$/);
    document.documentElement.dataset.theme = 'dark';
    rerender(<AppleWalletBadge href="/p/x/pass.pkpass" label="All passes (3)" />);
    expect(screen.getByRole('img', { name: 'Add to Apple Wallet' }).getAttribute('src')).toBe(
      '/apple/badge/en/outline.svg',
    );
    expect(screen.getByText('All passes (3)')).toBeInTheDocument();
  });

  it('renders the same badge as HTML for SSR and email', () => {
    expect(appleWalletBadgeHtml({ href: '/p/a"b' })).toContain('href="/p/a&#34;b"');
    expect(appleWalletBadgeHtml({ href: '/x', email: { origin: 'https://w.example' } })).toContain(
      'https://w.example/apple/badge/en/black@2x.png',
    );
  });
});

describe('FilterBar', () => {
  it('renders "Label: value" triggers, fills set ones and offers Clear', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(
      <FilterBar
        search={{ value: '', onChange: () => {}, placeholder: 'Search passes' }}
        onClear={onClear}
        filters={[
          {
            id: 'status',
            label: 'Status',
            value: 'voided',
            defaultValue: 'all',
            options: [
              { value: 'all', label: 'All' },
              { value: 'voided', label: 'Voided' },
            ],
            onChange: () => {},
          },
          {
            id: 'date',
            label: 'Date',
            value: 'any',
            defaultValue: 'any',
            options: DATE_RANGES,
            onChange: () => {},
          },
        ]}
      />,
    );
    const status = screen.getByRole('combobox', { name: 'Status: Voided' });
    expect(status).toHaveTextContent('Status:Voided');
    expect(status.className).toContain('bg-accent-subtle');
    expect(screen.getByRole('combobox', { name: 'Date: any' })).not.toHaveClass('bg-accent-subtle');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalled();
    expect(rangeStart('7d', 8 * 86_400_000)).toBe(86_400_000);
    expect(rangeStart('any', 1)).toBeUndefined();
  });
});
