import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomerDisplayPage } from './customer-display.tsx';

afterEach(() => {
  delete window.PassBookCustomerDisplay;
  vi.unstubAllGlobals();
});

describe('Duo customer display', () => {
  it('shows the shared Buddy scene for each generic native status update', async () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) => ({ matches: false, media: query }) as MediaQueryList,
    );
    const bridge = {
      status: 'ready' as const,
      revision: 0,
      onmessage: null as ((event: { data: string }) => void) | null,
    };
    window.PassBookCustomerDisplay = bridge;
    const { container } = render(<CustomerDisplayPage />);
    const screenPage = container.querySelector('[data-testid="duo-customer-display"]');
    const buddy = container.querySelector('[data-buddy]');

    expect(screenPage).toHaveAttribute('data-status', 'ready');
    expect(buddy).toHaveAttribute('data-scene', 'wave');
    expect(screen.getByRole('heading', { name: 'Ready' })).toBeVisible();

    await act(async () => {
      bridge.onmessage?.({ data: JSON.stringify({ status: 'checking', revision: 1 }) });
    });
    await waitFor(() => {
      expect(screenPage).toHaveAttribute('data-status', 'checking');
      expect(buddy).toHaveAttribute('data-scene', 'search');
      expect(screen.getByRole('heading', { name: 'Checking pass' })).toBeVisible();
    });

    await act(async () => {
      bridge.onmessage?.({ data: JSON.stringify({ status: 'checkedOut', revision: 2 }) });
    });
    await waitFor(() => {
      expect(screenPage).toHaveAttribute('data-status', 'checkedOut');
      expect(buddy).toHaveAttribute('data-scene', 'wave');
      expect(screen.getByRole('heading', { name: "You're checked out" })).toBeVisible();
    });

    await act(async () => {
      bridge.onmessage?.({ data: JSON.stringify({ status: 'rejected', revision: 3 }) });
    });
    await waitFor(() => {
      expect(screenPage).toHaveAttribute('data-status', 'rejected');
      expect(buddy).toHaveAttribute('data-scene', 'sorry');
      expect(screen.getByRole('heading', { name: 'Please see staff' })).toBeVisible();
    });
  });

  it('renders only organization branding and falls back when its logo cannot load', () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) => ({ matches: false, media: query }) as MediaQueryList,
    );
    const bridge = {
      status: 'ready' as const,
      revision: 0,
      branding: {
        name: 'Northwind',
        accent: '#0f766e',
        logoSha: 'a'.repeat(64),
      },
      onmessage: null as ((event: { data: string }) => void) | null,
    };
    window.PassBookCustomerDisplay = bridge;
    const { container } = render(<CustomerDisplayPage />);
    const page = screen.getByTestId('duo-customer-display');
    const logo = screen.getByRole('img', { name: 'Organization logo' });

    expect(screen.getByText('Northwind')).toBeVisible();
    expect(logo).toHaveAttribute('src', `/api/v1/scan/branding/logo?v=${'a'.repeat(64)}`);
    expect(page.style.getPropertyValue('--scan-org-accent')).toBe('#0f766e');
    expect(container).not.toHaveTextContent('Private pass holder');

    fireEvent.error(logo);
    expect(screen.getByText('N')).toBeVisible();

    act(() => {
      bridge.onmessage?.({
        data: JSON.stringify({
          status: 'accepted',
          revision: 1,
          branding: { ...bridge.branding, holder: 'Private pass holder' },
        }),
      });
    });
    expect(screen.getByRole('heading', { name: 'Ready' })).toBeVisible();
  });
});
