import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../../lib/test-utils.tsx';
import { ScanBoundary } from './scan-boundary.tsx';
import { ScanFrame } from './scan-frame.tsx';

afterEach(() => vi.restoreAllMocks());

describe('scan frame under Trusted Types', () => {
  it('builds its page without document.write', async () => {
    const write = vi.spyOn(Document.prototype, 'write').mockImplementation(() => {
      throw new TypeError("This document requires 'TrustedHTML' assignment.");
    });
    render(
      <ScanFrame device="phone" theme="light" label="Scan preview">
        <p>Inside</p>
      </ScanFrame>,
    );
    const doc = (screen.getByTitle('Scan preview') as HTMLIFrameElement).contentDocument;
    expect(doc?.getElementById('root')).not.toBeNull();
    expect(doc?.querySelector('meta[name="viewport"]')).not.toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
});

describe('scan boundary', () => {
  it('shows the reason and a way back instead of the app-wide error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onBack = vi.fn();
    function Boom(): never {
      throw new Error('bad shape');
    }
    render(
      <ScanBoundary onBack={onBack}>
        <Boom />
      </ScanBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Scan screen failed to load: bad shape');
    await userEvent.click(screen.getByRole('button', { name: 'Back to Pass' }));
    expect(onBack).toHaveBeenCalled();
  });
});
