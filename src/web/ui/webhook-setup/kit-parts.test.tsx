import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import '../../lib/test-utils.tsx';
import { Toaster } from '../toaster.tsx';
import {
  CopyRow,
  inboundTrouble,
  outboundTrouble,
  RotateSecretForm,
  SetupSteps,
  TopicChecklist,
  TwoSided,
  useRotateSecret,
  VerifyGuide,
} from './index.ts';
import { STEPS, setViewport, TOPICS, URL_VALUE } from './test-support.test-support.tsx';
import type { ArrivalReason } from './types.ts';

afterEach(() => {
  localStorage.clear();
  setViewport(1440);
});

describe('space neutrality', () => {
  it('imports nothing from a space, like ui/operation', () => {
    const dir = import.meta.dirname;
    for (const file of readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.includes('.test'))) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text, file).not.toMatch(
        /from '[^']*\/(admin|portal|developers|scan|marketing|routes)\//,
      );
    }
  });
});

describe('CopyRow', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('copies, says Copied until the next copy anywhere, and names the button', async () => {
    const user = userEvent.setup();
    render(
      <>
        <CopyRow label="Endpoint URL" value={URL_VALUE} />
        <CopyRow label="Signature header" value="x-passbook-signature" />
        <Toaster />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Copy endpoint URL' }));
    expect(await navigator.clipboard.readText()).toBe(URL_VALUE);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Endpoint URL copied' })).toHaveTextContent(
        'Copied',
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Copy signature header' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copy endpoint URL' })).toHaveTextContent('Copy'),
    );
  });
});

describe('TopicChecklist', () => {
  it('counts required topics seen, ticks them, folds the optional ones and says labels may differ', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TopicChecklist topics={TOPICS} />);
    expect(screen.getByText('0 of 2 seen')).toBeInTheDocument();
    expect(screen.getByText('2 more optional')).toBeInTheDocument();
    expect(screen.getByText('Labels may differ.')).toBeInTheDocument();
    rerender(<TopicChecklist topics={TOPICS} seen={['orders/create']} />);
    expect(screen.getByText('1 of 2 seen')).toBeInTheDocument();
    expect(screen.getByText(/orders\/create/).closest('li')).toHaveTextContent('(seen)');
    await user.click(screen.getByRole('button', { name: '2 more optional' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect((await axe(document.body)).violations).toEqual([]);
  });

  it('draws a tick only for a topic that arrives after it mounted', () => {
    const { container, rerender } = render(
      <TopicChecklist topics={TOPICS} seen={['orders/create']} />,
    );
    expect(container.querySelector('.wl-step-done')).toBeNull();
    rerender(<TopicChecklist topics={TOPICS} seen={['orders/create', 'orders/updated']} />);
    expect(container.querySelectorAll('.wl-step-done')).toHaveLength(1);
  });
});

describe('SetupSteps', () => {
  it('renders every part of the guide from data', async () => {
    const { container } = render(
      <SetupSteps steps={STEPS} values={{ endpointUrl: URL_VALUE }} topics={TOPICS} />,
    );
    expect(screen.getByRole('group', { name: 'Menu path' })).toHaveTextContent(
      'Settings›Notifications›Webhooks',
    );
    expect(screen.getByText('Settings', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy URL' })).toBeInTheDocument();
    expect(screen.getByText('(choose this)')).toBeInTheDocument();
    expect(screen.getByText('Subscribe to')).toBeInTheDocument();
    expect(screen.getByText(/Choose/)).toBeInTheDocument();
    expect(screen.getAllByText('Labels may differ.').length).toBeGreaterThan(0);
    expect(screen.getByText('In PassBook')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('says where a missing value comes from instead of an empty row', () => {
    render(<SetupSteps steps={STEPS} values={{}} topics={TOPICS} />);
    expect(screen.getByText('Not available yet.')).toBeInTheDocument();
  });

  it('remembers Done ticks per key, in storage that may be missing', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<SetupSteps steps={STEPS} values={{}} storageKey="k1" />);
    await user.click(screen.getAllByRole('checkbox', { name: 'Done' })[0] as HTMLElement);
    expect(JSON.parse(localStorage.getItem('k1') ?? '[]')).toEqual(['open']);
    unmount();
    render(<SetupSteps steps={STEPS} values={{}} storageKey="k1" />);
    expect(screen.getAllByRole('checkbox', { name: 'Done' })[0]).toBeChecked();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await user.click(screen.getAllByRole('checkbox', { name: 'Done' })[1] as HTMLElement);
    expect(screen.getAllByRole('checkbox', { name: 'Done' })[1]).toBeChecked();
    vi.restoreAllMocks();
  });

  it('is an accordion on a phone: one step open, and Done opens the next', async () => {
    setViewport(390);
    const user = userEvent.setup();
    render(<SetupSteps steps={STEPS} values={{}} />);
    const heads = screen.getAllByRole('button', { name: /Open Webhooks|Create webhook|Save/ });
    expect(heads.map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'false']);
    await user.click(screen.getByRole('checkbox', { name: 'Done' }));
    expect(screen.getByRole('button', { name: /Open Webhooks/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByRole('button', { name: /Create webhook/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

describe('TwoSided', () => {
  const sides = (w: number) => {
    setViewport(w);
    return render(
      <TwoSided guide={<p>guide</p>} panel={<p>panel</p>} strip={<span>strip</span>} />,
    );
  };

  it('puts the panel beside the guide at 1440', () => {
    sides(1440);
    expect(screen.getByRole('complementary', { name: 'PassBook' })).toHaveTextContent('panel');
    expect(screen.queryByText('strip')).toBeNull();
  });

  it('folds the panel into a strip at 834 that opens as a disclosure, still mounted', async () => {
    const user = userEvent.setup();
    sides(834);
    expect(screen.getByText('strip')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /Details/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('panel', { selector: 'p' }).closest('[hidden]')).not.toBeNull();
    await user.click(toggle);
    expect(screen.getByRole('button', { name: /Hide/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('panel').closest('[hidden]')).toBeNull();
  });

  it('stacks at 390 with no strip', () => {
    sides(390);
    expect(screen.queryByText('strip')).toBeNull();
    expect(screen.getByText('panel')).toBeInTheDocument();
  });
});

describe('VerifyGuide and RotateSecretForm', () => {
  it('shows the scheme, the three languages and a curl test with the receiver url', async () => {
    const user = userEvent.setup();
    const { container } = render(<VerifyGuide url="https://me.example/hook" />);
    expect(screen.getByRole('tab', { name: 'Node' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Python' }));
    expect(screen.getByRole('region', { name: 'Python verify snippet' })).toHaveTextContent(
      'hmac.compare_digest',
    );
    await user.click(screen.getByRole('tab', { name: 'Go' }));
    expect(screen.getByRole('region', { name: 'Go verify snippet' })).toHaveTextContent(
      'hmac.Equal',
    );
    await user.click(screen.getByRole('tab', { name: 'Test with curl' }));
    expect(screen.getByRole('region', { name: 'curl test' })).toHaveTextContent(
      'https://me.example/hook',
    );
    expect((await axe(container)).violations).toEqual([]);
  });

  function Host({ rotate }: { rotate: (h: number) => Promise<{ secret: string }> }) {
    const state = useRotateSecret(rotate);
    return (
      <>
        <RotateSecretForm state={state} onDone={() => undefined} />
        <button type="submit" form={state.formId}>
          Rotate
        </button>
      </>
    );
  }

  it('rotates with the chosen overlap and shows the new secret once', async () => {
    const user = userEvent.setup();
    const rotate = vi.fn(async () => ({ secret: 'whsec_new' }));
    render(<Host rotate={rotate} />);
    await user.click(screen.getByRole('radio', { name: '3 days' }));
    await user.click(screen.getByRole('button', { name: 'Rotate' }));
    expect(rotate).toHaveBeenCalledWith(72);
    expect(await screen.findByText('Signing secret')).toBeInTheDocument();
  });

  it('warns that Now stops the old secret, and shows a failure in words', async () => {
    const user = userEvent.setup();
    render(<Host rotate={async () => Promise.reject(new Error('nope'))} />);
    await user.click(screen.getByRole('radio', { name: 'Now' }));
    expect(screen.getByText(/stops working now/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Rotate' }));
    expect(await screen.findByText(/nope|went wrong|Could not/i)).toBeInTheDocument();
  });
});

describe('troubleshooting copy', () => {
  const REASONS: ArrivalReason[] = [
    'signature_missing',
    'signature_mismatch',
    'signature_expired',
    'payload',
    'too_large',
    'no_secret',
  ];
  const IGNORED: ArrivalReason[] = [
    'unknown_type',
    'thin_event',
    'test_mode',
    'unrecognized_shape',
    'no_ref',
    'ping',
    'stale',
  ];
  const ctx = { provider: 'Shopify', origin: 'provider' as const };

  it('has a title and a one-sentence fix for every ledger reason', () => {
    for (const reason of REASONS) {
      const t = inboundTrouble({ outcome: 'rejected', reason, topic: null }, ctx);
      expect(t.tone, reason).toBe('danger');
      expect(t.fix.length, reason).toBeGreaterThan(10);
    }
    for (const reason of IGNORED) {
      const t = inboundTrouble({ outcome: 'ignored', reason, topic: 'products/update' }, ctx);
      expect(t.title, reason).not.toBe('Not used');
    }
    expect(inboundTrouble(null, ctx).title).toBe('Nothing arrived');
  });

  it('prefers the recipe line, and keeps the replace action for provider-made secrets only', () => {
    const own = inboundTrouble(
      { outcome: 'rejected', reason: 'signature_mismatch', topic: null },
      { ...ctx, recipeFix: { signature_mismatch: 'Use the client secret.' } },
    );
    expect(own.fix).toBe('Use the client secret.');
    expect(own.action).toBe('replaceSecret');
    const mine = inboundTrouble(
      { outcome: 'rejected', reason: 'signature_mismatch', topic: null },
      { provider: 'WooCommerce', origin: 'passbook' },
    );
    expect(mine.action).toBeUndefined();
  });

  it('reads XML apart from other bad bodies, a pass as success and an old secret as info', () => {
    expect(
      inboundTrouble(
        { outcome: 'rejected', reason: 'payload', topic: null, contentClass: 'xml' },
        ctx,
      ).title,
    ).toBe('Wrong format');
    expect(inboundTrouble({ outcome: 'ignored', reason: 'stale', topic: null }, ctx).tone).toBe(
      'success',
    );
    expect(
      inboundTrouble({ outcome: 'accepted', reason: null, topic: 'a', usedPrevious: true }, ctx)
        .tone,
    ).toBe('info');
  });

  it('diagnoses a test send from its status and code', () => {
    const r = (status: number | null, errorCode?: string, ok = false) =>
      outboundTrouble({ ok, status, errorCode, durationMs: 140 });
    expect(outboundTrouble({ ok: true, status: 200, durationMs: 140 }).fix).toBe(
      'Your server answered 200 in 140 ms.',
    );
    expect(r(401).title).toBe('Refused');
    expect(r(404).title).toBe('Wrong path');
    expect(r(302).title).toBe('Redirected');
    expect(r(503).title).toBe('Server error');
    expect(r(null, 'timeout').title).toBe('Too slow');
    expect(r(null, 'tls_error').fix).toMatch(/certificate/);
    expect(r(null, 'weird').title).toBe('Unreachable');
  });
});
