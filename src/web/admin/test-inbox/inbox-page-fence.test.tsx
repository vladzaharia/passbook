import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { setMode } from '@/web/lib/mode.ts';
import { renderApp } from '@/web/lib/test-utils.tsx';
import { handlers, orgAccess, setupInboxTest } from './inbox-page-test-fixtures.ts';
import { FENCE_GRACE, FENCE_TTL } from './send-fence.ts';

setupInboxTest();

const fence = (value: string, age: number) =>
  localStorage.setItem('test-inbox-forward:e1', JSON.stringify({ value, at: Date.now() - age }));

async function open() {
  setMode('test');
  await renderApp('/admin/test-inbox?email=e1', {
    session: 'admin',
    ...orgAccess,
    handlers,
  });
}

describe('Test inbox send fence', () => {
  it('blocks another send while a recent unconfirmed send is unresolved', async () => {
    fence('unconfirmed', 1_000);
    await open();
    expect(await screen.findByText('Send outcome unconfirmed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled();
  });

  it('releases the fence once the server shows nothing reserved after the grace', async () => {
    fence('unconfirmed', FENCE_GRACE + 1_000);
    await open();
    const send = await screen.findByRole('button', { name: 'Send to me' });
    await waitFor(() => expect(send).toBeEnabled());
    expect(screen.queryByText('Send outcome unconfirmed')).toBeNull();
    expect(localStorage.getItem('test-inbox-forward:e1')).toBeNull();
  });

  it('releases a fence older than its TTL', async () => {
    fence('unconfirmed', FENCE_TTL + 1_000);
    await open();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send to me' })).toBeEnabled());
  });

  it('releases a fence an older build stored without a time', async () => {
    localStorage.setItem('test-inbox-forward:e1', 'unconfirmed');
    await open();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send to me' })).toBeEnabled());
  });
});
