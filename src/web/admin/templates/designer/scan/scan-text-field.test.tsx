import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ScanText } from '@/passkit/template/scan-display/schema.ts';
import '../../../../lib/test-utils.tsx';
import { manifest, passJson } from './scan-fields-test-fixtures.ts';
import { ScanTextField } from './scan-text-fields.tsx';

describe('scan binding fields', () => {
  it('inserts tokens, disables private choices and removes a token with Backspace', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    function Example() {
      const [value, setValue] = useState<ScanText | undefined>('Hello ');
      return (
        <ScanTextField
          label="Greeting"
          value={value}
          manifest={manifest}
          passJson={passJson}
          audienceRole="desk"
          mergeKey="scan:r:greeting"
          onChange={(v, merge) => {
            changed(v, merge);
            setValue(v);
          }}
        />
      );
    }
    render(<Example />);
    await user.click(screen.getByRole('combobox', { name: /Insert field into Greeting/ }));
    expect(screen.getByRole('option', { name: /inputs phone Number/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(screen.getByRole('option', { name: /inputs tier/i }));
    expect(changed).toHaveBeenLastCalledWith('Hello {{inputs.tier}}', undefined);
    const token = screen.getByRole('button', { name: 'Field inputs tier' });
    token.focus();
    await user.keyboard('{Backspace}');
    expect(changed).toHaveBeenLastCalledWith('Hello ', undefined);
  });

  it('keeps the literal focused and retains the later duplicate token when the first is removed', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    function Example() {
      const [value, setValue] = useState<ScanText | undefined>(
        'Hello {{inputs.quantity}} and {{inputs.quantity}}!',
      );
      return (
        <ScanTextField
          label="Greeting"
          value={value}
          manifest={manifest}
          mergeKey="scan:r:greeting"
          onChange={(next, merge) => {
            changed(next, merge);
            setValue(next);
          }}
        />
      );
    }
    render(<Example />);
    const literal = screen.getByRole('textbox', { name: 'Greeting' }) as HTMLInputElement;
    const tokens = screen.getAllByRole('button', { name: 'Field inputs quantity' });
    expect(tokens).toHaveLength(2);
    const first = tokens[0] as HTMLElement;
    const later = tokens[1] as HTMLElement;
    expect(first).not.toBe(later);

    literal.focus();
    literal.setSelectionRange(literal.value.length, literal.value.length);
    await user.keyboard('again ');
    expect(screen.getByRole('textbox', { name: 'Greeting' })).toBe(literal);
    expect(literal).toHaveFocus();
    expect(changed).toHaveBeenLastCalledWith(
      'Hello again {{inputs.quantity}} and {{inputs.quantity}}!',
      'scan:r:greeting',
    );
    const tokensAfterEdit = screen.getAllByRole('button', { name: 'Field inputs quantity' });
    expect(tokensAfterEdit[0]).toBe(first);
    expect(tokensAfterEdit[1]).toBe(later);

    await user.click(
      screen.getAllByRole('button', { name: 'Remove inputs quantity' })[0] as HTMLElement,
    );
    expect(changed).toHaveBeenLastCalledWith('Hello again  and {{inputs.quantity}}!', undefined);
    expect(screen.getByRole('button', { name: 'Field inputs quantity' })).toBe(later);
    expect(first).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Greeting' })).toBe(literal);
  });

  it('discards an open advanced draft when its audience loses access', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ScanTextField
        label="Title"
        value="{{inputs.tier}}"
        manifest={manifest}
        audienceRole="desk"
        mergeKey="scan:title"
        onChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Advanced expression' }));
    expect(screen.getByLabelText('Title expression')).toHaveValue('{{inputs.tier}}');
    rerender(
      <ScanTextField
        label="Title"
        value="{{inputs.tier}}"
        manifest={manifest}
        audienceRole="door"
        mergeKey="scan:title"
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('Title expression')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Advanced expression' }));
    expect(screen.getByLabelText('Title expression')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Field Unavailable field' })).toBeInTheDocument();
  });

  it.each(['person@example.test', '+1 212 555 0199', '{"secret":"data"}'])(
    'hides unsafe literal text while retaining the source',
    async (source) => {
      const user = userEvent.setup();
      const changed = vi.fn();
      render(
        <ScanTextField
          label="Message"
          value={source}
          manifest={manifest}
          mergeKey="scan:message"
          onChange={changed}
        />,
      );
      expect(screen.queryByDisplayValue(source)).not.toBeInTheDocument();
      expect(screen.getByText(/Sensitive text hidden and preserved/)).toBeInTheDocument();
      expect(changed).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Advanced expression' }));
      expect(screen.getByLabelText('Message expression')).toHaveValue('');
      await user.click(screen.getByRole('button', { name: 'Replace Message text' }));
      expect(changed).toHaveBeenCalledWith('', undefined);
    },
  );

  it('limits title fields and preserves plural forms while editing', () => {
    const changed = vi.fn();
    const value = {
      count: '{{inputs.quantity}}',
      one: '# visit',
      other: '# visits',
      zero: 'No visits',
    };
    render(
      <ScanTextField
        label="Title"
        value={value}
        manifest={manifest}
        mergeKey="scan:title"
        allowedPaths={['holder.name', 'holder.firstName']}
        allowFormats={false}
        onChange={changed}
      />,
    );
    fireEvent.change(screen.getByLabelText('Title singular'), { target: { value: '# entry' } });
    expect(changed).toHaveBeenLastCalledWith({ ...value, one: '# entry' }, 'scan:title:one');
    expect(value.one).toBe('# visit');
    expect(screen.queryByRole('combobox', { name: /Format/ })).not.toBeInTheDocument();
  });

  it('says why a contact detail is refused and accepts dates, times and ranges', () => {
    const changed = vi.fn();
    render(
      <ScanTextField
        label="Note"
        value="Hello"
        manifest={manifest}
        mergeKey="scan:note"
        onChange={changed}
      />,
    );
    const input = screen.getByLabelText('Note');
    fireEvent.change(input, { target: { value: 'Call +1 212 555 0100' } });
    expect(changed).not.toHaveBeenCalled();
    expect(input).toBeInvalid();
    expect(screen.getByText('Remove contact details, links or private text.')).toBeVisible();
    fireEvent.change(input, { target: { value: 'Valid until 2026-11-30' } });
    expect(changed).toHaveBeenLastCalledWith('Valid until 2026-11-30', 'scan:note');
    expect(screen.queryByText(/Remove contact details/)).not.toBeInTheDocument();
    for (const text of ['Doors 18.00 - 23.00', 'Season 2025-2026', 'Open 30.11.2026'])
      fireEvent.change(input, { target: { value: text } });
    expect(changed).toHaveBeenLastCalledWith('Open 30.11.2026', 'scan:note');
    fireEvent.change(input, { target: { value: 'Use {{x' } });
    expect(screen.getByText('Add fields with Insert field.')).toBeVisible();
  });
});
