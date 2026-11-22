import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import vectorFile from '../../../../docs/api/webhook-vectors.json';
import type { WebhookCaptureDto } from '../../../shared/contracts/webhook-captures.ts';
import type { WebhookEndpointDto } from '../../../shared/contracts/webhooks.ts';
import type { WebhookVector } from '../../../shared/webhook-verify.ts';
import { ApiProblem, type TesterApi, type TesterAuth } from './client.ts';
import { Tester } from './tester.tsx';

const vector = (vectorFile.vectors as WebhookVector[]).find(
  (v) => v.id === 'valid',
) as WebhookVector;
const SECRET = vector.secrets[0] as string;

const endpoint = {
  id: 'ep1',
  target: 'capture',
  description: 'Test capture endpoint',
} as WebhookEndpointDto;

const capture = (over: Partial<WebhookCaptureDto> = {}): WebhookCaptureDto => ({
  id: 'c1',
  endpointId: 'ep1',
  eventId: 'e1',
  type: 'pass.updated',
  trigger: 'event',
  status: 200,
  durationMs: 12,
  headers: vector.headers,
  body: vector.body,
  createdAt: vector.now * 1000,
  ...over,
});

const urlEndpoint = {
  id: 'ep2',
  target: 'url',
  description: '',
  urlMasked: 'hooks.example.dev/…',
  eventTypes: ['pass.issued'],
  status: 'active',
  lastStatus: 200,
} as WebhookEndpointDto;

function api(
  captures: WebhookCaptureDto[],
  endpoints: WebhookEndpointDto[] = [endpoint],
): TesterApi & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    endpoints: async () => endpoints,
    createEndpoint: async (url, eventTypes) => {
      sent.push(`create ${url} ${eventTypes.join(',')}`);
      return { endpoint: urlEndpoint, secret: 'whsec_once' };
    },
    deliveries: async () => [],
    replayDelivery: async () => undefined,
    rotate: async () => 'whsec_rotated',
    delivery: async () => {
      throw new Error('none');
    },
    tests: async () => [
      {
        id: 't1',
        type: 'pass.updated',
        ok: true,
        status: 204,
        errorCode: null,
        durationMs: 31,
        at: 1,
      },
    ],
    ensureCapture: async () => endpoint,
    captures: async (_id, type) => captures.filter((c) => !type || c.type === type),
    sendTest: async (_id, type) => {
      sent.push(type);
      return { ok: true, captureId: 'c1', status: 200, errorCode: null };
    },
    replay: async () => capture({ id: 'c2', trigger: 'replay' }),
    secret: async () => SECRET,
  };
}

const ready =
  (a: TesterApi): (() => Promise<TesterAuth>) =>
  async () => ({ kind: 'ready', api: a });
beforeAll(() => {
  // jsdom has no modal dialogs.
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
    close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});

const TYPES = ['pass.issued', 'pass.updated', 'webhook.test'];

describe('Tester', () => {
  it('asks a signed-out visitor to sign in, and one without a sandbox to make it', async () => {
    const { unmount } = render(
      <Tester connect={async () => ({ kind: 'signed-out' })} types={TYPES} />,
    );
    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?next=%2Fdevelopers%2Fwebhooks',
    );
    unmount();
    render(<Tester connect={async () => ({ kind: 'no-sandbox' })} types={TYPES} />);
    expect(await screen.findByRole('link', { name: 'Open the quickstart' })).toBeInTheDocument();
  });

  it('lists captures, opens the newest on Verify and shows every step passing with the vectors', async () => {
    render(<Tester connect={ready(api([capture()]))} types={TYPES} />);
    expect(await screen.findByText('Signature matches')).toBeInTheDocument();
    expect(screen.getByText('Timestamp is recent')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/of 11 pass|of \d+ pass/)).toBeInTheDocument());
    expect(screen.getByText('Listening')).toBeInTheDocument();
    // The secret is masked until asked for.
    expect(screen.getByText(/^•+.{4}$/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(screen.getByText(SECRET)).toBeInTheDocument();
  });

  it('names the fix when the body was re-serialized', async () => {
    render(<Tester connect={ready(api([capture()]))} types={TYPES} />);
    await screen.findByText('Signature matches');
    await userEvent.click(screen.getByText('Check what your receiver saw'));
    const pretty = JSON.stringify(JSON.parse(vector.body), null, 2);
    await userEvent.click(screen.getByLabelText('Body as your receiver read it'));
    await userEvent.paste(pretty);
    expect(await screen.findByText('Signature does not match')).toBeInTheDocument();
    expect(
      screen.getByText('You signed re-serialized JSON; sign the raw request body, before parsing.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/expected v1=/)).toBeInTheDocument();
  });

  it('sends the chosen event type and follows the capture it made', async () => {
    const fake = api([capture()]);
    render(<Tester connect={ready(fake)} types={TYPES} />);
    await screen.findByText('Signature matches');
    await userEvent.selectOptions(screen.getByLabelText('Event type to send'), 'pass.issued');
    await userEvent.click(screen.getByRole('button', { name: 'Send test event' }));
    await waitFor(() => expect(fake.sent).toEqual(['pass.issued']));
  });

  it('shows the headers and the raw body of a capture, and replays it', async () => {
    const fake = api([capture()]);
    const replay = vi.spyOn(fake, 'replay');
    render(<Tester connect={ready(fake)} types={TYPES} />);
    await screen.findByText('Signature matches');
    await userEvent.click(screen.getByRole('tab', { name: 'Headers' }));
    expect(screen.getByLabelText('Request headers')).toHaveTextContent('x-passbook-timestamp:');
    await userEvent.click(screen.getByRole('tab', { name: 'Body' }));
    expect(screen.getByLabelText('Request body')).toHaveTextContent('"type": "pass.updated"');
    await userEvent.click(screen.getByRole('button', { name: 'Replay' }));
    await waitFor(() => expect(replay).toHaveBeenCalledWith('ep1', 'c1'));
  });

  it('says what to do when nothing is captured yet', async () => {
    render(<Tester connect={ready(api([]))} types={TYPES} />);
    expect(await screen.findByText('Nothing captured yet. Send a test event.')).toBeInTheDocument();
    expect(within(document.body).getByText('Nothing to inspect')).toBeInTheDocument();
  });

  it('offers a retry when the sandbox cannot be reached', async () => {
    const connect = vi
      .fn<() => Promise<TesterAuth>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ kind: 'signed-out' });
    render(<Tester connect={connect} types={TYPES} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('lists URL endpoints beside the capture endpoint and shows their test sends as deliveries', async () => {
    render(<Tester connect={ready(api([capture()], [urlEndpoint, endpoint]))} types={TYPES} />);
    await screen.findByText('Signature matches');
    const eps = screen
      .getAllByRole('button', { pressed: undefined })
      .filter((b) => b.className.includes('wh-ep'));
    expect(eps.map((b) => b.textContent)).toEqual([
      expect.stringContaining('Capture endpoint'),
      expect.stringContaining('hooks.example.dev/…'),
    ]);
    await userEvent.click(eps[1] as HTMLElement);
    expect(await screen.findByText('Test')).toBeInTheDocument();
    expect(screen.getAllByText('webhook.test').length).toBeGreaterThan(0);
    expect(screen.getAllByText('204').length).toBeGreaterThan(0);
  });

  it('adds a URL endpoint with every subscribable event and shows the secret once', async () => {
    const fake = api([capture()]);
    render(<Tester connect={ready(fake)} types={TYPES} />);
    await screen.findByText('Signature matches');
    await userEvent.click(screen.getByRole('button', { name: 'Add endpoint' }));
    await userEvent.type(screen.getByLabelText(/^URL/), 'https://hooks.example.dev/in');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('whsec_once')).toBeInTheDocument();
    expect(screen.getByText('Shown once')).toBeInTheDocument();
    expect(fake.sent).toContain('create https://hooks.example.dev/in pass.issued,pass.updated');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('whsec_once')).toBeNull();
  });

  it('rotates a URL endpoint secret, shows it once and drops it after Copy', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (t: string) => void written.push(t) },
      configurable: true,
    });
    render(<Tester connect={ready(api([capture()], [urlEndpoint, endpoint]))} types={TYPES} />);
    await screen.findByText('Signature matches');
    await userEvent.click(
      screen.getAllByRole('button').filter((b) => b.className.includes('wh-ep'))[1] as HTMLElement,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Rotate' }));
    // One confirm first; nothing is called until it.
    expect(screen.getByText(/The old one keeps signing for 24 hours/)).toBeInTheDocument();
    expect(screen.queryByText('whsec_rotated')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    expect(await screen.findByText('whsec_rotated')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy secret' }));
    await waitFor(() => expect(screen.queryByText('whsec_rotated')).toBeNull(), { timeout: 3000 });
    expect(written).toEqual(['whsec_rotated']);
  });

  it('hides a shown secret after a minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<Tester connect={ready(api([capture()], [urlEndpoint, endpoint]))} types={TYPES} />);
      await screen.findByText('Signature matches');
      await userEvent.click(screen.getByRole('button', { name: 'Add endpoint' }));
      await userEvent.type(screen.getByLabelText(/^URL/), 'https://hooks.example.dev/in');
      await userEvent.click(screen.getByRole('button', { name: 'Add' }));
      expect(await screen.findByText('whsec_once')).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(60_000);
      await waitFor(() => expect(screen.queryByText('whsec_once')).toBeNull());
      expect(screen.getByText(/Hidden\. Rotate the secret/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks for a recent sign-in when the server does, with a link back to this page', async () => {
    const fake = api([capture()]);
    fake.createEndpoint = async () => {
      throw new ApiProblem(
        403,
        'STEP_UP_REQUIRED',
        'Sign in again.',
        '/auth/oidc/start?prompt=login',
      );
    };
    render(<Tester connect={ready(fake)} types={TYPES} />);
    await screen.findByText('Signature matches');
    await userEvent.click(screen.getByRole('button', { name: 'Add endpoint' }));
    await userEvent.type(screen.getByLabelText(/^URL/), 'https://hooks.example.dev/in');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    const link = await screen.findByRole('link', { name: 'Continue' });
    expect(link.getAttribute('href')).toContain('/auth/oidc/start');
    expect(link.getAttribute('href')).toContain('next=%2Fdevelopers%2Fwebhooks');
    expect(screen.getByText("Confirm it's you")).toBeInTheDocument();
  });
});
