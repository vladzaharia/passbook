import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import '../../../../lib/test-utils.tsx';
import { ScanModeSafe } from './scan-mode-safe.tsx';

vi.mock('./scan-mode.tsx', () => {
  throw new Error('chunk 404');
});

describe('ScanModeSafe', () => {
  it('shows the failure and a way back when the scan screen code cannot load, never a skeleton', async () => {
    const onBack = vi.fn();
    render(<ScanModeSafe templateId="t1" orgId={null} issues={null} onBack={onBack} />);
    expect(await screen.findByText(/Scan screen failed to load/)).toBeInTheDocument();
    expect(screen.queryByRole('status', { busy: true })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back to Pass' }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
