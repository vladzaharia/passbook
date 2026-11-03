import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import '../lib/test-utils.tsx';
import { EmailList } from './email-list.tsx';
import { FormField } from './field.tsx';
import { Form, useFormErrors } from './form.tsx';
import { InlineAddField } from './inline-add-field.tsx';
import { Input } from './input.tsx';
import { SaveBar } from './save-bar.tsx';
import { TooltipProvider } from './tooltip.tsx';

/** The polite summary renders a frame after the errors. */
const nextFrame = () => act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));

describe('useFormErrors with Form', () => {
  function Harness({ onValid }: { onValid: () => void }) {
    const [name, setName] = useState('');
    const [slug, setSlug] = useState('');
    const check = useFormErrors({
      name: name.trim() ? undefined : 'Required.',
      slug: /^[a-z]+$/.test(slug) ? undefined : 'Use lowercase letters.',
    });
    return (
      <>
        <Form id="f" {...check.form} onValid={onValid}>
          <FormField label="Name" required error={check.errors.name}>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
          </FormField>
          <FormField label="Slug" required error={check.errors.slug}>
            {(p) => <Input {...p} value={slug} onChange={(e) => setSlug(e.target.value)} />}
          </FormField>
        </Form>
        <SaveBar dirty formId="f" onDiscard={() => {}} />
      </>
    );
  }

  it('shows errors on submit, focuses the first, announces once and clears each as it is fixed', async () => {
    const user = userEvent.setup();
    const onValid = vi.fn();
    render(<Harness onValid={onValid} />);
    // Nothing while typing into a fresh form.
    await user.type(screen.getByLabelText(/Slug/), 'A');
    expect(screen.queryByText('Use lowercase letters.')).toBeNull();
    // SaveBar's Save submits the form by id.
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onValid).not.toHaveBeenCalled();
    expect(screen.getByText('Required.')).toBeInTheDocument();
    expect(screen.getByText('Use lowercase letters.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/Name/)).toHaveFocus());
    await nextFrame();
    expect(screen.getByText('2 fields need attention')).toHaveAttribute('role', 'status');
    // Live once shown: the fix clears its message on the same keystroke.
    await user.type(screen.getByLabelText(/Name/), 'Acme');
    expect(screen.queryByText('Required.')).toBeNull();
    await user.clear(screen.getByLabelText(/Slug/));
    await user.type(screen.getByLabelText(/Slug/), 'acme');
    expect(screen.queryByText('Use lowercase letters.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onValid).toHaveBeenCalledOnce();
  });
});

describe('InlineAddField blocked submit', () => {
  function Harness({ onSubmit }: { onSubmit: (v: string) => void }) {
    const [v, setV] = useState('');
    return (
      <InlineAddField
        label="Add tag"
        value={v}
        onChange={setV}
        onSubmit={onSubmit}
        validate={(x) =>
          !x ? 'Enter a tag.' : x.length < 3 ? 'Use 3 letters or more.' : undefined
        }
      />
    );
  }

  it('refuses with the error, focus on the field and one summary; clears once valid', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const field = screen.getByLabelText('Add tag');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field).toHaveAccessibleDescription('Enter a tag.');
    await waitFor(() => expect(field).toHaveFocus());
    await nextFrame();
    expect(screen.getByRole('status')).toHaveTextContent('1 field needs attention');
    await user.type(field, 'ab');
    expect(field).toHaveAccessibleDescription('Use 3 letters or more.');
    await user.type(field, 'c');
    expect(field).not.toHaveAttribute('aria-invalid');
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('abc');
  });
});

describe('EmailList add row', () => {
  it('checks the address like the server before calling onAdd', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const noop = () => {};
    render(
      <TooltipProvider>
        <EmailList
          items={[]}
          onAdd={onAdd}
          onRemove={noop}
          onMakePrimary={noop}
          onResend={noop}
          onCancelPending={noop}
        />
      </TooltipProvider>,
    );
    const field = screen.getByLabelText('Add email');
    await user.type(field, 'nope{Enter}');
    expect(onAdd).not.toHaveBeenCalled();
    expect(field).toHaveAccessibleDescription('Enter a valid email.');
    await waitFor(() => expect(field).toHaveFocus());
    await user.type(field, '@example.com{Enter}');
    expect(onAdd).toHaveBeenCalledWith('nope@example.com');
  });
});
