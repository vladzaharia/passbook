import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { homeFresh } from '../workbench/home-fixtures.ts';
import { SandboxStep } from './sandbox-step.tsx';
import type { Quickstart } from './use-quickstart.ts';

vi.mock('./make-sandbox.tsx', () => ({
  MakeSandbox: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));

const sandbox = { id: 's', orgSlug: 'dev-1', templateId: 'tpl-1' };
const quickstart = (home: Quickstart['home']): Quickstart =>
  ({
    session: { kind: 'ready', csrf: 'c', siteKey: 'k', sandbox },
    sandbox,
    secret: null,
    templateId: 'tpl-1',
    csrf: 'c',
    home,
    sandboxMade: () => undefined,
  }) as unknown as Quickstart;

describe('the sandbox step', () => {
  it('offers Start over and Delete on a closed sandbox', () => {
    const closed = {
      session: { kind: 'closed', csrf: 'c', siteKey: 'k' },
      sandbox: null,
      secret: null,
      templateId: null,
      csrf: 'c',
      home: null,
      sandboxMade: () => undefined,
    } as unknown as Quickstart;
    render(<SandboxStep q={closed} state="current" onNext={() => undefined} />);
    expect(screen.getByRole('button', { name: /Start over/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Delete sandbox/ })).toBeTruthy();
  });

  it('shows Retry, not a spinner, when the home has no capture endpoint', () => {
    const home = { ...homeFresh, endpoints: [] };
    const { container } = render(
      <SandboxStep q={quickstart(home)} state="current" onNext={() => undefined} />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Setup did not finish');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(container.querySelector('.qs-spin')).toBeNull();
  });

  it('waits quietly until the home is read', () => {
    const { container } = render(
      <SandboxStep q={quickstart(null)} state="current" onNext={() => undefined} />,
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(container.querySelector('.qs-spin')).not.toBeNull();
  });
});
