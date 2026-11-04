import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, renderApp } from '@/web/lib/test-utils.tsx';

const org = {
  id: 'o1',
  slug: 'acme',
  name: 'Acme Gym',
  status: 'active',
  defaultIdentityId: null,
  branding: { accent: '#0f766e' },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  counts: { passes: 12, templates: 2, connections: 1, apiKeys: 3 },
  countsCapped: false,
};
const entry = (key: string, value: unknown) => ({
  scope: 'org:o1',
  key,
  value,
  updatedAt: null,
  updatedBy: null,
});
const handlers = {
  '/api/v1/orgs/o1': () => json(org),
  '/api/v1/identities': () => json({ items: [], nextCursor: null }),
  '/api/v1/settings': () =>
    json({
      items: [entry('support.email', 'help@acme.test'), entry('email.buddy', false)],
      oidc: { issuer: 'https://id.plrs.im', adminGroup: null, userGroup: null },
    }),
};
const frame = () => screen.getByTitle('Sample pass email') as HTMLIFrameElement;
const src = () => decodeURIComponent(frame().getAttribute('src') ?? '');

afterEach(() => vi.restoreAllMocks());

describe('PassEmailPreview', () => {
  it('follows the unsaved support contacts once typing settles, and only valid ones', async () => {
    await renderApp('/admin/orgs/o1', { session: 'admin', handlers });
    const ui = userEvent.setup();
    const email = await screen.findByLabelText('Support email');
    expect(email).toHaveValue('help@acme.test');
    // Saved values are the Worker's own: the frame asks for nothing else.
    expect(src()).toMatch(/\/email-preview\?buddy=0&v=\d+$/);
    await ui.clear(email);
    await ui.type(email, 'desk@acme');
    // Not an address yet: the frame keeps the last email Save could produce.
    await new Promise((r) => setTimeout(r, 500));
    expect(src()).toMatch(/\?buddy=0&v=\d+$/);
    await ui.type(email, '.test');
    await waitFor(() => expect(src()).toContain('?buddy=0&supportEmail=desk@acme.test&v='));
    await ui.type(screen.getByLabelText('Support URL'), 'https://acme.test/help');
    await waitFor(() => expect(src()).toContain('&supportUrl=https://acme.test/help&'));
    // Cleared, as Save would clear it.
    await ui.clear(email);
    await waitFor(() => expect(src()).toContain('?buddy=0&supportEmail=&supportUrl='));
  });

  it('lays the email out at a phone width and scales it into a narrow column', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(352);
    await renderApp('/admin/orgs/o1', { session: 'admin', handlers });
    await screen.findByTitle('Sample pass email');
    expect(frame().style.width).toBe('390px');
    expect(frame().style.transform).toBe(`scale(${350 / 390})`);
    width.mockRestore();
  });

  it('uses the width it has, up to the email column, unscaled', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
    await renderApp('/admin/orgs/o1', { session: 'admin', handlers });
    await screen.findByTitle('Sample pass email');
    expect(frame().style.width).toBe('512px');
    expect(frame().style.transform).toBe('');
  });
});
