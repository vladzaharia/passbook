import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PairConfirm } from './pair-confirm.tsx';

describe('PairConfirm', () => {
  it('asks to join the session, names the org and mode, and joins on Join', async () => {
    const onPair = vi.fn();
    render(
      <PairConfirm
        scannerName="Front desk 2"
        sessionName="Front desk"
        orgName="Rain City Fit"
        mode="live"
        onPair={onPair}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Join Front desk?' })).toBeInTheDocument();
    expect(screen.getByText('Rain City Fit · Live')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Join' }));
    expect(onPair).toHaveBeenCalledOnce();
  });

  it('says Test in Test mode and falls back to the device name without a session', () => {
    render(
      <PairConfirm
        scannerName="Till 1"
        orgName="Northwind"
        mode="test"
        onPair={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Join Till 1?' })).toBeInTheDocument();
    expect(screen.getByText('Northwind · Test')).toBeInTheDocument();
  });
});
