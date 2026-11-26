import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import '@/web/lib/test-utils.tsx';
import { ZoneDialog } from './zone-dialog.tsx';

describe('ZoneDialog inside another form', () => {
  it('keeps its submits and typing from reaching the form that holds it', async () => {
    const submitted = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    const typed = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <form onSubmit={submitted} onInput={typed}>
          <ZoneDialog orgId="o1" zones={[]} onClose={() => {}} />
        </form>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'New zone' });
    await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Pool');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(
      await within(dialog).findByRole('heading', { name: 'Track who is inside' }),
    ).toBeVisible();
    expect(submitted).not.toHaveBeenCalled();
    expect(typed).not.toHaveBeenCalled();
  });
});
