import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { EnvBox } from './sandbox-step.tsx';

const SECRET = 'pbp_test_demo0001_demo-demo-demo-demo';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the key box', () => {
  it('says how to load .env and check it, for both shells', () => {
    const { container } = render(
      <EnvBox secret={SECRET} templateId="tpl-1" onNext={() => undefined} />,
    );
    expect(container.textContent).toContain('set -a; . ./.env; set +a');
    expect(container.textContent).toContain('Get-Content .env');
    expect(container.textContent).toContain(QS_COPY.made.checkLine);
  });

  it('shows the key once as text, masks it after Copy .env, and copies both lines', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { container } = render(
      <EnvBox secret={SECRET} templateId="tpl-1" onNext={() => undefined} />,
    );
    expect(container.textContent).toContain(`PASSBOOK_KEY=${SECRET}`);
    expect(screen.getByText('Shown once')).toBeTruthy();
    // Only text nodes: no attribute carries the secret.
    for (const el of container.querySelectorAll('*'))
      for (const a of el.getAttributeNames()) expect(el.getAttribute(a)).not.toContain(SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Copy .env' }));
    expect(writeText).toHaveBeenCalledWith(`PASSBOOK_KEY=${SECRET}\nPASSBOOK_TEMPLATE_ID=tpl-1\n`);
    expect(container.textContent).not.toContain(SECRET);
    expect(container.textContent).toContain('pbp_test_…demo');
    expect(screen.getByText('Key hidden')).toBeTruthy();
  });

  it('masks the key when the user moves on with Next, and Copy .env still copies the whole key', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const onNext = vi.fn();
    const { container } = render(<EnvBox secret={SECRET} templateId="tpl-1" onNext={onNext} />);
    await userEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(onNext).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain(SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Copy .env' }));
    expect(writeText).toHaveBeenCalledWith(`PASSBOOK_KEY=${SECRET}\nPASSBOOK_TEMPLATE_ID=tpl-1\n`);
  });

  it('masks the key after a minute even if it was never copied', () => {
    vi.useFakeTimers();
    const { container } = render(
      <EnvBox secret={SECRET} templateId="tpl-1" onNext={() => undefined} />,
    );
    expect(container.textContent).toContain(SECRET);
    act(() => vi.advanceTimersByTime(60_000));
    expect(container.textContent).not.toContain(SECRET);
  });
});
