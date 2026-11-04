import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import '../../../lib/test-utils.tsx';
import { Card, TooltipProvider } from '../../../ui/index.ts';
import { cleanValues, type FormValues, sameValues, validateValues } from './schema.ts';
import { SchemaForm } from './schema-form.tsx';

const schema = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      maxItems: 3,
      'x-widget': 'list',
      'x-label': 'Upcoming events',
      'x-itemLabel': 'Event',
      'x-addLabel': 'Add event',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', 'x-label': 'Name', 'x-order': 1, minLength: 1, maxLength: 20 },
          seats: { type: 'integer', 'x-label': 'Seats', 'x-order': 2, minimum: 1 },
        },
      },
    },
  },
};

function Harness({
  initial = {},
  onValue,
  ...rest
}: { initial?: FormValues; onValue?: (v: FormValues) => void } & Partial<
  React.ComponentProps<typeof SchemaForm>
>) {
  const [value, setValue] = useState<FormValues>(initial);
  return (
    <TooltipProvider>
      <Card>
        <SchemaForm
          schema={schema}
          value={value}
          onChange={(v) => {
            setValue(v);
            onValue?.(v);
          }}
          {...rest}
        />
      </Card>
    </TooltipProvider>
  );
}
const names = () =>
  screen.queryAllByRole('textbox', { name: /Name/ }).map((el) => (el as HTMLInputElement).value);
const two = { events: [{ name: 'A' }, { name: 'B' }] };

describe('list schema', () => {
  it('validates each row and the length', () => {
    expect(
      validateValues(schema, { events: [{ name: 'ok' }, {}, { name: 'x'.repeat(30) }] }),
    ).toEqual({
      'events.1.name': 'Required.',
      'events.2.name': 'At most 20 characters.',
    });
    expect(
      validateValues(schema, {
        events: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
      }),
    ).toEqual({
      events: 'At most 3.',
    });
    expect(validateValues(schema, {})).toEqual({});
  });

  it('cleans empty fields and rows, and ignores key order when comparing', () => {
    expect(
      cleanValues({ events: [{ name: 'A', seats: undefined }, {}, { seats: 4, name: 'B' }] }),
    ).toEqual({
      events: [{ name: 'A' }, { name: 'B', seats: 4 }],
    });
    expect(cleanValues({ events: [{}] })).toEqual({});
    expect(
      sameValues({ events: [{ seats: 1, name: 'A' }] }, { events: [{ name: 'A', seats: 1 }] }),
    ).toBe(true);
  });
});

describe('ListInput', () => {
  it('adds a row, focuses its first field and announces it', async () => {
    const user = userEvent.setup();
    let latest: FormValues = {};
    const { container } = render(<Harness onValue={(v) => (latest = v)} />);
    expect(screen.getByRole('group', { name: 'Upcoming events' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add event' }));
    expect(screen.getByRole('textbox', { name: /Name/ })).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Event 1 added.');
    await user.keyboard('Opener');
    expect(latest).toEqual({ events: [{ name: 'Opener' }] });
    expect((await axe(container)).violations).toEqual([]);
  });

  it('stops adding at the maximum', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ events: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] }} />);
    expect(screen.getByRole('button', { name: 'Add event' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Remove Event 3' }));
    expect(screen.getByRole('button', { name: 'Add event' })).toBeEnabled();
  });

  it('reorders with the buttons, keeps focus and announces', async () => {
    const user = userEvent.setup();
    let latest: FormValues = {};
    render(<Harness initial={two} onValue={(v) => (latest = v)} />);
    expect(screen.getByRole('button', { name: 'Move Event 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Event 2 down' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Move Event 1 down' }));
    expect(names()).toEqual(['B', 'A']);
    expect(latest).toEqual({ events: [{ name: 'B' }, { name: 'A' }] });
    expect(screen.getByRole('status')).toHaveTextContent('Event moved to position 2 of 2.');
    // The row that moved to the end has its down arrow disabled, so focus lands on up.
    expect(screen.getByRole('button', { name: 'Move Event 2 up' })).toHaveFocus();
  });

  it('moves the row you are in with Alt and the arrow keys', async () => {
    const user = userEvent.setup();
    render(<Harness initial={two} />);
    const first = screen.getAllByRole('textbox', { name: /Name/ })[0] as HTMLElement;
    first.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(names()).toEqual(['B', 'A']);
    expect(screen.getAllByRole('textbox', { name: /Name/ })[1]).toHaveFocus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(names()).toEqual(['A', 'B']);
  });

  it('removes a row and moves focus to the one that took its place', async () => {
    const user = userEvent.setup();
    let latest: FormValues = {};
    render(<Harness initial={two} onValue={(v) => (latest = v)} />);
    await user.click(screen.getByRole('button', { name: 'Remove Event 1' }));
    expect(names()).toEqual(['B']);
    expect(latest).toEqual({ events: [{ name: 'B' }] });
    expect(screen.getByRole('status')).toHaveTextContent('Event 1 removed.');
    await user.click(screen.getByRole('button', { name: 'Remove Event 1' }));
    expect(latest).toEqual({});
    expect(screen.getByRole('button', { name: 'Add event' })).toHaveFocus();
  });

  it("keeps a row's typed text and error state with the row when it moves", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ events: [{ name: 'A' }, {}] }} />);
    const second = screen.getAllByRole('textbox', { name: /Name/ })[1] as HTMLElement;
    await user.click(second);
    await user.tab();
    expect(await screen.findByText('Required.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move Event 2 up' }));
    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0] as HTMLElement).getByText('Required.')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).queryByText('Required.')).toBeNull();
  });

  it('shows row errors on submit and server errors with either separator', async () => {
    const { container, rerender } = render(
      <Harness initial={{ events: [{}, { name: 'B' }] }} showAllErrors />,
    );
    expect(
      within(screen.getAllByRole('listitem')[0] as HTMLElement).getByText('Required.'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('textbox', { name: /Name/ })[0]).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect((await axe(container)).violations).toEqual([]);
    rerender(
      <Harness
        initial={{ events: [{ name: 'A' }, { name: 'B' }] }}
        serverErrors={{ 'events/1/name': 'Already used.' }}
      />,
    );
    expect(
      within(screen.getAllByRole('listitem')[1] as HTMLElement).getByText('Already used.'),
    ).toBeInTheDocument();
  });

  it('is read-only when disabled', () => {
    render(<Harness initial={two} disabled />);
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
  });
});
