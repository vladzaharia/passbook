import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/errors.ts';
import '../lib/test-utils.tsx';
import { FormField } from './field.tsx';
import { useFormErrors } from './form.tsx';
import { FormDialog, type FormDialogProps } from './form-dialog.tsx';
import { Input } from './input.tsx';

function Harness({
  onSubmit,
  onClose,
  ...rest
}: { onSubmit: () => unknown; onClose?: () => void } & Partial<FormDialogProps>) {
  const [open, setOpen] = useState(true);
  const [reason, setReason] = useState('');
  const check = useFormErrors(reason ? {} : { reason: 'Required.' });
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="Place hold"
        check={check}
        dirty={reason !== ''}
        onSubmit={onSubmit}
        submitLabel="Place hold"
        onClose={() => {
          setReason('');
          onClose?.();
        }}
        {...rest}
      >
        {({ errors, clear }) => (
          <FormField label="Reason" required error={check.errors.reason ?? errors.reason}>
            {(p) => (
              <Input
                {...p}
                data-autofocus
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  clear('reason');
                }}
              />
            )}
          </FormField>
        )}
      </FormDialog>
    </>
  );
}

describe('FormDialog', () => {
  it('focuses the first field, blocks an empty submit with its errors, and submits a valid form', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const dialog = await screen.findByRole('dialog', { name: 'Place hold' });
    await waitFor(() => expect(within(dialog).getByLabelText(/Reason/)).toHaveFocus());
    await user.click(within(dialog).getByRole('button', { name: 'Place hold' }));
    expect(await within(dialog).findByText('Required.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText(/Reason/), 'Legal');
    await user.click(within(dialog).getByRole('button', { name: 'Place hold' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  });

  it('maps a server field error under its field and clears it on the fix', async () => {
    const user = userEvent.setup();
    const onSubmit = () => {
      throw new ApiError({ status: 422, code: 'x', fields: { reason: 'Too long.' } });
    };
    render(<Harness onSubmit={onSubmit} />);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'Legal');
    await user.click(within(dialog).getByRole('button', { name: 'Place hold' }));
    expect(await within(dialog).findByText('Too long.')).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByLabelText(/Reason/)).toHaveFocus());
    await user.type(within(dialog).getByLabelText(/Reason/), '!');
    expect(within(dialog).queryByText('Too long.')).toBeNull();
  });

  it('shows any other error on one line at the foot', async () => {
    const user = userEvent.setup();
    const onSubmit = () => {
      throw new ApiError({
        status: 409,
        code: 'x',
        title: 'Already held.',
        detail: 'Already held.',
      });
    };
    render(<Harness onSubmit={onSubmit} />);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'Legal');
    await user.click(within(dialog).getByRole('button', { name: 'Place hold' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Already held.');
  });

  it('Cancel closes at once, clears the draft and hides the errors', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onSubmit={() => undefined} onClose={onClose} />);
    let dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Place hold' }));
    await within(dialog).findByText('Required.');
    await user.type(within(dialog).getByLabelText(/Reason/), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onClose).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/Reason/)).toHaveValue('');
    expect(within(dialog).queryByText('Required.')).toBeNull();
  });

  it('puts the notice on top and the extra action left of Cancel', async () => {
    render(
      <Harness
        onSubmit={() => undefined}
        notice={<p>Stale copy.</p>}
        extra={<button type="button">Email link</button>}
      />,
    );
    const dialog = await screen.findByRole('dialog');
    const form = dialog.querySelector('form');
    expect(form?.firstElementChild).toHaveTextContent('Stale copy.');
    const names = within(dialog)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names.indexOf('Email link')).toBeLessThan(names.indexOf('Cancel'));
  });

  it('is not dismissible when asked: no X, Esc ignored', async () => {
    const user = userEvent.setup();
    render(<Harness onSubmit={() => undefined} dismissible={false} />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('swaps in a result with its own title and no X', async () => {
    render(
      <Harness
        onSubmit={() => undefined}
        result={{ title: 'New signing secret', body: <p>whsec</p> }}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: /New signing secret/ });
    expect(within(dialog).getByText('whsec')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
    await waitFor(() => expect(dialog.querySelector('h2 [tabindex="-1"]')).toHaveFocus());
  });

  it('says so when a refused field has no control to show it', async () => {
    const user = userEvent.setup();
    const onSubmit = () => {
      throw new ApiError({ status: 422, code: 'x', fields: { other: 'Not allowed here.' } });
    };
    render(<Harness onSubmit={onSubmit} />);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason/), 'Legal');
    await user.click(within(dialog).getByRole('button', { name: 'Place hold' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Not allowed here.');
  });

  it('runs onClose when the parent closes it', async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <FormDialog
        open
        onOpenChange={() => undefined}
        title="T"
        onSubmit={() => undefined}
        submitLabel="Go"
        onClose={onClose}
      >
        <p>x</p>
      </FormDialog>,
    );
    rerender(
      <FormDialog
        open={false}
        onOpenChange={() => undefined}
        title="T"
        onSubmit={() => undefined}
        submitLabel="Go"
        onClose={onClose}
      >
        <p>x</p>
      </FormDialog>,
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
