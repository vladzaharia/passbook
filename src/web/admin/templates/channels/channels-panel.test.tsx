import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json } from '@/web/lib/test-utils.tsx';
import { calls, renderTags } from '../../tags/test-fixtures.tsx';
import { TemplateChannelsPanel } from './channels-panel.tsx';

const on = { on: true, source: 'template' };
const effective = {
  mobile: on,
  apple: on,
  google: { on: false, source: 'template', reason: 'no_design' },
  samsung: { on: false, source: 'template', reason: 'no_design' },
  paper: { on: false, source: 'template', reason: 'template_off' },
  nfc: on,
};
const impact = (passes: number, cleared = 0) => [
  { channel: 'apple', passes, rotated: 0, clearedOverrides: cleared },
];
const handlers = (passes: number, cleared = 0) => ({
  '/api/v1/templates/t1/channels': (_u: URL, init?: RequestInit) =>
    init?.method === 'PUT'
      ? json({
          channels: null,
          revision: 1,
          effective,
          impact: impact(passes, cleared),
          workflowInstanceId: null,
        })
      : json({ channels: null, revision: 0, effective }),
});
const group = (name: string) => screen.getByRole('radiogroup', { name });
const choose = (name: string, state: string) =>
  userEvent.click(within(group(name)).getByRole('radio', { name: state }));
const bodies = (m: ReturnType<typeof renderTags>['fetchMock']) =>
  calls(m, 'PUT', '/channels').map(([, init]) => JSON.parse(String(init?.body)));

afterEach(() => vi.restoreAllMocks());

describe('Template channels', () => {
  it('disables a channel the template cannot offer and says why', async () => {
    renderTags(<TemplateChannelsPanel templateId="t1" orgId="o1" canPublish />, handlers(0));
    await screen.findByRole('radiogroup', { name: 'Apple Wallet' });
    expect(screen.getByText('Google Wallet: no design for this template')).toBeInTheDocument();
    expect(within(group('Google Wallet')).getByRole('radio', { name: 'On' })).toBeDisabled();
    expect(within(group('Paper')).getByRole('radio', { name: 'Off' })).toBeEnabled();
  });

  it('says a platform or organization block leaves copies alone', async () => {
    renderTags(<TemplateChannelsPanel templateId="t1" orgId="o1" canPublish />, {
      '/api/v1/templates/t1/channels': () =>
        json({
          channels: null,
          revision: 0,
          effective: {
            ...effective,
            paper: { on: false, source: 'platform', reason: 'printing_off' },
          },
        }),
    });
    expect(
      await screen.findByText(
        'Paper: printing off for all organizations. Copies stay as they are.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Google Wallet: no design for this template')).toBeInTheDocument();
  });

  it('shows the effect before saving, then saves with the revision', async () => {
    const { fetchMock } = renderTags(
      <TemplateChannelsPanel templateId="t1" orgId="o1" canPublish />,
      handlers(412),
    );
    await screen.findByRole('radiogroup', { name: 'Apple Wallet' });
    await choose('Apple Wallet', 'Off');
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Turns off Apple Wallet for 412 passes.');
    expect(dialog).toHaveTextContent('Copies keep working until New code.');
    expect(bodies(fetchMock)).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies(fetchMock)).toHaveLength(2));
    expect(bodies(fetchMock)[0]).toMatchObject({ dryRun: true, orgId: 'o1' });
    expect(bodies(fetchMock)[1]).toEqual({
      channels: { apple: 'off' },
      revision: 0,
      orgId: 'o1',
    });
  });

  it('names the overrides a Never clears', async () => {
    renderTags(<TemplateChannelsPanel templateId="t1" orgId="o1" canPublish />, handlers(0, 37));
    await screen.findByRole('radiogroup', { name: 'Apple Wallet' });
    await choose('Apple Wallet', 'Never');
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Clears 37 pass overrides.');
  });

  it('is read-only without templates:publish', async () => {
    renderTags(
      <TemplateChannelsPanel templateId="t1" orgId="o1" canPublish={false} />,
      handlers(0),
    );
    await screen.findByRole('radiogroup', { name: 'Apple Wallet' });
    expect(within(group('Apple Wallet')).getByRole('radio', { name: 'Off' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
